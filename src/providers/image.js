/**
 * Картинки для кадров: три пути, по порядку силы.
 *
 * 1. Инбокс `projects/<id>/images/` — всё, что человек сгенерировал сам (в
 *    Midjourney, Flux, Ideogram — где угодно) и положил в папку. Этот путь
 *    главный и никогда не оспаривается: если картинка лежит руками, никакая
 *    автоматика её не переписывает.
 * 2. Внешний провайдер (NVIDIA FLUX или Gemini) — если доступ у ключа есть.
 * 3. Свой рисовальщик кодом (`render.js`) — если ничего из верхнего не вышло.
 *
 * Ключевое: недоступность провайдера не ошибка, а обычное состояние. Поэтому у
 * каждого провайдера есть причина отказа текстом, и она печатается человеку —
 * чтобы он знал, что именно включить, а не догадывался.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const TIMEOUT_MS = 120_000;

/** Панель кадра: 16:9 того же размера, что и монтаж. */
export const PANEL = { width: 1920, height: 1080 };

/**
 * Повтор на временных сбоях.
 *
 * 500 и обрывы связи у генератора — обычное дело: три кадра из двадцати пяти
 * отвалились именно так, и без повтора они остались бы нарисованными кодом, хотя
 * через пару секунд сервер отвечает нормально. Повторяем только то, что имеет
 * смысл повторять: 5xx, 429 и сетевые обрывы. 4xx — это про нас, а не про сервер.
 */
async function withRetry(attempt, { tries = 3, delays = [1500, 5000, 12000], label = "запрос" } = {}) {
  let last;
  for (let attemptNumber = 1; attemptNumber <= tries; attemptNumber += 1) {
    try {
      const result = await attempt();
      if (result?.ok) return result;
      // Провайдер ответил, но без картинки: повторяем только на временных кодах.
      const temporary = /ответил 5\d\d|ответил 429|не дошло|timeout|aborted/i.test(String(result?.reason ?? ""));
      if (!temporary || attemptNumber === tries) return result;
      last = result;
    } catch (error) {
      last = { ok: false, reason: `не дошло: ${String(error?.message ?? error).slice(0, 120)}` };
      if (attemptNumber === tries) return last;
    }
    const wait = delays[Math.min(attemptNumber - 1, delays.length - 1)];
    console.warn(`  ${label}: временный сбой, повтор через ${Math.round(wait / 1000)} с`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return last;
}

async function fetchWithTimeout(url, options, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ищет картинку кадра в инбоксе проекта.
 *
 * Номер кадра ищется с любым расширением и в двух видах (`7.png` и `007.png`):
 * человек не обязан угадывать, как именно назвать файл.
 */
export function panelFromInbox({ projectDir, shotNumber }) {
  const dir = join(projectDir, "images");
  if (!existsSync(dir)) return null;
  const names = [String(shotNumber), String(shotNumber).padStart(3, "0"), String(shotNumber).padStart(4, "0")];
  const files = readdirSync(dir);
  for (const name of names) {
    const found = files.find((file) => {
      const [stem, ext] = [file.slice(0, file.lastIndexOf(".")), file.slice(file.lastIndexOf(".")).toLowerCase()];
      return stem === name && IMAGE_EXTENSIONS.includes(ext);
    });
    if (found) return join(dir, found);
  }
  return null;
}

/**
 * Сколько кадров уже закрыто картинками из инбокса.
 * Отдельная функция, потому что это первое, что стоит знать про проект.
 */
export function inboxReport({ projectDir, shots }) {
  const ready = shots.filter((shot) => panelFromInbox({ projectDir, shotNumber: shot.n }));
  return { ready: ready.length, total: shots.length };
}

// ── NVIDIA ────────────────────────────────────────────────────────────────────

/**
 * NVIDIA рисует FLUX-ом на отдельном хосте и ждёт МИНИМАЛЬНОЕ тело: только
 * `prompt`. Лишние поля сервер отвергает (`ratio` — «Extra inputs are not
 * permitted», `cfg_scale` — только ≤ 0), а имя модели пишется с точкой
 * (`flux.1-dev`), не с подчёркиванием. Обжёгся на обоих: сначала получил 404 от
 * неверного имени и решил, что генерации нет вообще.
 *
 * Ответ приходит как base64 в `artifacts[0].base64`, причём внутри JPEG, а не
 * PNG — поэтому формат определяется по содержимому, а не по имени поля.
 */
export async function generateNvidia({ prompt, env, extra = {} }) {
  const key = env.NVIDIA_API_KEY;
  if (!key) return { ok: false, reason: "нет NVIDIA_API_KEY" };

  const url = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev";
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, ...extra }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      reason:
        `NVIDIA ответил ${response.status}` +
        (response.status === 404
          ? ": модель недоступна по этому ключу"
          : `: ${detail.slice(0, 200)}`),
    };
  }

  const data = await response.json();
  const base64 = data?.artifacts?.[0]?.base64;
  if (!base64) return { ok: false, reason: "NVIDIA вернул ответ без картинки" };
  return { ok: true, base64, reason: "nvidia" };
}

/**
 * Настоящий формат картинки по её первым байтам.
 *
 * Имя поля в ответе (`base64`) ничего не говорит о формате, а писать JPEG под
 * именем .png нельзя: часть площадок потом отказывается его читать.
 */
export function imageExtension(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer.subarray(0, 8).toString("binary") === "\x89PNG\r\n\x1a\n") return ".png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF") return ".webp";
  return ".png";
}

// ── Gemini ────────────────────────────────────────────────────────────────────

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

/** Gemini отвечает картинкой прямо в ответе модели (`inlineData`). */
export async function generateGemini({ prompt, env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, reason: "нет GEMINI_API_KEY" };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // Просим именно картинку: без этого модель отвечает текстом.
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const quota = detail.includes("free_tier") || response.status === 429;
    return {
      ok: false,
      reason:
        `Gemini ответил ${response.status}` +
        (quota
          ? ": на бесплатном тарифе генерация картинок не входит в квоту (limit: 0)"
          : `: ${detail.slice(0, 200)}`),
    };
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part.inlineData?.data);
  if (!image) return { ok: false, reason: "Gemini ответил без картинки" };
  return { ok: true, base64: image.inlineData.data, reason: "gemini" };
}

// ── общий сбор ────────────────────────────────────────────────────────────────

/**
 * Кто сейчас может рисовать — проверкой, а не по наличию ключа.
 * @returns {Promise<{nvidia:object, gemini:object}>} у каждого `available` и `reason`
 */
export async function probeImageProviders(env) {
  const probe = "A single simple line drawing of a stick figure standing on a white background.";
  const result = {};
  for (const [name, attempt] of [
    ["nvidia", () => generateNvidia({ prompt: probe, env })],
    ["gemini", () => generateGemini({ prompt: probe, env })],
  ]) {
    try {
      const answer = await withRetry(attempt, { tries: 2, delays: [2000, 6000], label: `проба ${name}` });
      result[name] = { available: answer.ok, reason: answer.reason };
    } catch (err) {
      result[name] = { available: false, reason: `не дошло: ${String(err?.message ?? err).slice(0, 120)}` };
    }
  }
  return result;
}

/**
 * Собирает картинки для кадров проекта.
 *
 * Порядок силы: инбокс руками → внешний провайдер → ничего (сборка нарисует сама).
 * Возвращает карту номер кадра → путь, чтобы её можно было сразу отдать в
 * `assemble`, и честный отчёт о том, что получилось и почему не получилось.
 */
export async function collectPanels({ projectDir, shots, prompts, env, provider = "auto", log = () => {} }) {
  const rendered = new Map();
  const fromInbox = [];
  const missing = [];

  for (const shot of shots) {
    const inbox = panelFromInbox({ projectDir, shotNumber: shot.n });
    if (inbox) {
      rendered.set(shot.n, inbox);
      fromInbox.push(shot.n);
    } else {
      missing.push(shot);
    }
  }
  if (fromInbox.length) log(`из инбокса: ${fromInbox.length} кадров (${fromInbox.slice(0, 5).join(", ")}${fromInbox.length > 5 ? "…" : ""})`);

  if (!missing.length) return { rendered, drawn: [], failed: [], provider: "inbox", reasons: [] };

  // Выбираем провайдера: явно указанный или первый доступный.
  const promptFor = new Map((prompts ?? []).map((p) => [p.shot, p.text]));
  const probe = provider === "auto" ? await probeImageProviders(env) : {};
  let chosen =
    provider !== "auto"
      ? provider
      : probe.nvidia?.available
        ? "nvidia"
        : probe.gemini?.available
          ? "gemini"
          : "none";

  const reasons = Object.entries(probe)
    .filter(([, info]) => !info.available)
    .map(([name, info]) => `${name}: ${info.reason}`);

  // Проба — советчик, а не приговор. У NVIDIA 403 «Authorization failed» приходит и
  // разово (ключом в ту же минуту идут десятки запросов), а решает она судьбу всех
  // двухсот двадцати пяти кадров сразу: из-за одного отказатого запроса фильм уходил
  // в запасной слой и рисовался кодом. Поэтому перед отказом пробуем нарисовать
  // первый настоящий кадр.
  if (chosen === "none") {
    for (const candidate of ["nvidia", "gemini"]) {
      const first = missing.find((shot) => promptFor.get(shot.n));
      if (!first) break;
      try {
        const attempt =
          candidate === "nvidia"
            ? await generateNvidia({ prompt: promptFor.get(first.n), env })
            : await generateGemini({ prompt: promptFor.get(first.n), env });
        if (attempt.ok) {
          chosen = candidate;
          log(`${candidate}: проба не прошла, но первый кадр нарисовался — рисуем им`);
          break;
        }
      } catch {
        /* следующий кандидат */
      }
    }
  }

  if (chosen === "none") {
    log(`внешние провайдеры не могут рисовать — кадры останутся нарисованными кодом`);
    for (const reason of reasons) log(`  ${reason}`);
    return { rendered, drawn: missing.map((s) => s.n), failed: [], provider: "none", reasons };
  }

  const dir = join(projectDir, "images");
  mkdirSync(dir, { recursive: true });

  const drawn = [];
  const failed = [];

  const queue = missing.filter((shot) => {
    if (!promptFor.get(shot.n)) {
      failed.push({ shot: shot.n, reason: "нет промта" });
      return false;
    }
    return true;
  });

  // Рисование — это почти целиком ожидание сети. Двести двадцать пять кадров по одному
  // в очереди занимают десятки минут, хотя сервис принимает несколько запросов разом.
  // Кадры независимы: у каждого свой промт, свой файл и свой номер.
  const atOnce = Math.max(
    1,
    Math.min(Number(env?.KADR_IMAGE_CONCURRENCY ?? process.env.KADR_IMAGE_CONCURRENCY ?? 3), queue.length || 1),
  );
  let cursor = 0;
  const drawShot = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= queue.length) return;
      const shot = queue[index];
      const prompt = promptFor.get(shot.n);
      try {
        const answer = await withRetry(
          () => (chosen === "nvidia" ? generateNvidia({ prompt, env }) : generateGemini({ prompt, env })),
          { label: `кадр ${shot.n}` },
        );
        if (!answer.ok) {
          failed.push({ shot: shot.n, reason: answer.reason });
          continue;
        }
        const bytes = Buffer.from(answer.base64, "base64");
        const file = join(dir, `${String(shot.n).padStart(4, "0")}${imageExtension(bytes)}`);
        writeFileSync(file, bytes);
        rendered.set(shot.n, file);
        drawn.push(shot.n);
        log(`  кадр ${shot.n} — ${chosen}`);
      } catch (err) {
        failed.push({ shot: shot.n, reason: String(err?.message ?? err).slice(0, 160) });
      }
    }
  };

  await Promise.all(Array.from({ length: atOnce }, drawShot));

  if (failed.length) {
    log(`не вышло на ${failed.length} кадрах, первый: ${failed[0].reason}`);
  }

  return { rendered, drawn, failed, provider: chosen, reasons };
}
