/**
 * Мозг конвейера: текст (идеи, сценарий, промты).
 *
 * Два бесплатных провайдера и переключение между ними. Это не украшение: у
 * бесплатных тарифов квоты кончаются посреди работы, и сценарий на 8 минут
 * стоит нескольких запросов подряд. Упёрлись в потолок у одного — продолжаем у
 * второго, а не теряем стадию.
 *
 * Ответ всегда ждём в JSON: сценарий — это структура (кадры, флаги, промты), и
 * разбирать её регулярками из вольного текста нельзя.
 */
import { readFileSync, existsSync } from "node:fs";

export function loadEnv(file = "/home/ibrohim/kadr/.env") {
  const env = { ...process.env };
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i < 1 || line.trim().startsWith("#")) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!env[key]) env[key] = value;
  }
  return env;
}

export class LlmUnavailable extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Вытаскивает JSON из ответа модели: она любит обернуть его в ```json. */
export function extractJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = Math.min(
    ...[body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0).concat([Infinity]),
  );
  if (!Number.isFinite(start)) throw new Error("в ответе модели нет JSON");
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error("JSON в ответе модели не закрыт");
}

async function callGemini({ system, user, env, json = true, temperature = 0.85 }) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new LlmUnavailable("нет GEMINI_API_KEY");
  const model = env.GEMINI_MODEL_TEXT || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: 8192,
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    },
  );
  const text = await res.text();
  if (res.status === 429) throw new LlmUnavailable(`Gemini: квота исчерпана (429)`);
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const out = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";
  if (!out.trim()) throw new Error("Gemini вернул пустой ответ");
  return out;
}

/**
 * Какие модели текста этот ключ Groq действительно видит.
 *
 * Список моделей у Groq меняется, и зашитое имя однажды перестаёт существовать —
 * именно так и случилось: запасной провайдер молча не работал, пока основной не
 * упёрся в квоту. Поэтому имя не угадывается, а спрашивается у сервиса.
 */
const GROQ_PREFERENCE = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b", "allam-2-7b"];
/** Служебные модели: распознавание речи и защита от промптов текста не пишут. */
const GROQ_NOT_TEXT = /whisper|orpheus|guard|tts|embed/i;

async function groqModels(key) {
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data?.data ?? []).map((m) => m?.id).filter((id) => typeof id === "string" && !GROQ_NOT_TEXT.test(id));
}

/** Первая доступная модель из списка предпочтений, иначе любая текстовая. */
async function pickGroqModel(key, env) {
  if (env.GROQ_MODEL_TEXT) return env.GROQ_MODEL_TEXT;
  const available = await groqModels(key);
  for (const preferred of GROQ_PREFERENCE) {
    if (available.includes(preferred)) return preferred;
  }
  return available[0] ?? "openai/gpt-oss-20b";
}

async function callGroq({ system, user, env, json = true, temperature = 0.85 }) {
  const key = env.GROQ_API_KEY;
  if (!key) throw new LlmUnavailable("нет GROQ_API_KEY");
  const model = await pickGroqModel(key, env);
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature,
      // Явный предел ответа: сценарий на участок — это большой JSON, и без этого
      // ответ приходит обрезанным.
      max_tokens: 8000,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
  });
  const text = await res.text();
  if (res.status === 429) throw new LlmUnavailable("Groq: квота исчерпана (429)");
  if (!res.ok) {
    const gone = res.status === 404 && text.includes("model_not_found");
    throw new Error(
      gone
        ? `Groq: модель «${model}» недоступна этому ключу. Доступны: ${(await groqModels(key)).join(", ")}`
        : `Groq ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = JSON.parse(text);
  const out = data?.choices?.[0]?.message?.content ?? "";
  if (!out.trim()) throw new Error("Groq вернул пустой ответ");
  return out;
}


/**
 * NVIDIA: тот же ключ, что рисует картинки, отвечает и текстом.
 *
 * Это лучший из бесплатных путей — своя квота, не общая с Gemini и Groq, и самый
 * быстрый ответ из виденных (около полутора секунд). Доступные этому ключу модели
 * проверены вживую; `mistral-large-2` и `nemotron-ultra-253b` ключу не выданы,
 * `kimi-k3` отвечает минутами.
 */
const NVIDIA_MODELS = [
  "deepseek-ai/deepseek-v4.1-flash",
  "nvidia/nemotron-3-super-120b-a12b",
  "z-ai/glm-5.3-flash",
];
let nvidiaModel = null;

async function callNvidia({ system, user, env, json = true, temperature = 0.85 }) {
  const key = env.NVIDIA_API_KEY || env.NVIDIA_KEY;
  if (!key) throw new LlmUnavailable("нет ключа NVIDIA");

  const candidates = nvidiaModel ? [nvidiaModel, ...NVIDIA_MODELS.filter((m) => m !== nvidiaModel)] : NVIDIA_MODELS;
  let lastError = null;

  for (const model of candidates) {
    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature,
        // Запас: у моделей с рассуждением часть ответа уходит в размышления, и при
        // маленьком пределе текст приходит пустым — так и случилась первая проба.
        max_tokens: 8000,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
      }),
    });
    const text = await res.text();

    if (res.status === 429) throw new LlmUnavailable("NVIDIA: квота исчерпана (429)");
    if (!res.ok) {
      lastError = `NVIDIA ${res.status} на «${model}»: ${text.replace(/\s+/g, " ").slice(0, 160)}`;
      continue; // модель может быть не выдана ключу — пробуем следующую
    }

    const data = JSON.parse(text);
    const message = data?.choices?.[0]?.message ?? {};
    const out = String(message.content ?? "");
    if (!out.trim()) {
      lastError = `NVIDIA «${model}»: пустой ответ (размышлений ${String(message.reasoning_content ?? "").length} знаков)`;
      continue;
    }

    nvidiaModel = model;
    return out;
  }

  throw new Error(lastError ?? "NVIDIA: ни одна модель не ответила");
}

/**
 * Спрашивает модель и возвращает разобранный JSON.
 *
 * Провайдеры перебираются по кругу, но отказ по квоте больше не означает
 * «делать нечего»: у бесплатных тарифов квота минутная, и через полминуты тот же
 * сервис отвечает. Раньше код сразу уходил к следующему провайдеру, упирался в
 * его квоту и падал — хотя достаточно было подождать. Поэтому на 429 и обрывах
 * ждём и повторяем тот же адрес, с растущей паузой.
 *
 * Отдельно про ответ, который не прошёл проверку JSON: у Groq это
 * `json_validate_failed`, и лечится повтором — обычно со второй попытки проходит.
 */
const QUOTA_WAITS = [25_000, 60_000, 120_000];

/**
 * Упёршиеся в квоту адреса, которые пока не трогаем.
 *
 * Если у сервиса кончилась дневная квота, он будет отказывать и через минуту, и
 * через десять. Стучаться в него на каждом запросе — это по минуте впустую на
 * каждое обращение: за длинный сценарий так теряется час. Поэтому адрес, дважды
 * отказавший по квоте, уходит в остывание и пропускается без стука.
 */
const cooling = new Map();
const COOLDOWN_MS = 10 * 60 * 1000;

function isCooling(name) {
  const until = cooling.get(name);
  if (!until) return false;
  if (Date.now() >= until) {
    cooling.delete(name);
    return false;
  }
  return true;
}

export async function askJson({ system, user, env = loadEnv(), json = true, temperature = 0.85, attempts = 3 }) {
  const providers = [
    ["nvidia", callNvidia],
    ["gemini", callGemini],
    ["groq", callGroq],
  ];
  const problems = [];

  for (const [name, call] of providers) {
    let quotaWaits = 0;

    if (isCooling(name)) {
      problems.push(`${name}: пропущен, квота исчерпана (остывает)`);
      continue;
    }

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const text = await call({ system, user, env, json, temperature });
        return json ? extractJson(text) : text;
      } catch (err) {
        const message = String(err?.message ?? err);
        const quota = err instanceof LlmUnavailable || /квота|429/.test(message);
        const badJson = /json_validate_failed|Failed to validate JSON/i.test(message);
        problems.push(`${name}: ${message.slice(0, 160)}`);

        const lastAttempt = attempt === attempts;
        if (quota && !lastAttempt && quotaWaits < QUOTA_WAITS.length) {
          // Первый отказ по квоте может быть минутным — ждём и пробуем ещё раз.
          // Второй подряд означает, что квота кончилась надолго: отправляем адрес
          // остывать и больше не тратим на него время.
          if (quotaWaits > 0) {
            cooling.set(name, Date.now() + COOLDOWN_MS);
            console.log(`  ${name}: квота держится, остывает ${Math.round(COOLDOWN_MS / 60000)} мин`);
            problems.push(`${name}: отказал дважды по квоте, остывает`);
            break;
          }
          const wait = QUOTA_WAITS[quotaWaits++];
          console.log(`  ${name}: квота, жду ${Math.round(wait / 1000)} с и пробую снова`);
          await sleep(wait);
          continue;
        }
        if (badJson && !lastAttempt) {
          // Ответ не прошёл проверку: повторяем, но просим короче.
          console.log(`  ${name}: ответ не разобрался как JSON, пробую снова`);
          await sleep(2000);
          continue;
        }
        if (!quota && !lastAttempt) await sleep(1500 * attempt);
        if (quota) break;
      }
    }
  }

  throw new LlmUnavailable(`ни один провайдер не ответил:\n- ${problems.join("\n- ")}`);
}

/** Кто вообще доступен — чтобы интерфейс не обещал того, чего нет. */
export function providersAvailable(env = loadEnv()) {
  return {
    gemini: Boolean(env.GEMINI_API_KEY),
    groq: Boolean(env.GROQ_API_KEY),
    nvidia: Boolean(env.NVIDIA_API_KEY),
  };
}
