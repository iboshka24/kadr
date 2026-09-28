/**
 * Раскрывает схему запроса у FLUX и пытается получить картинку.
 *
 * Прошлый вывод «NVIDIA даёт только текст» был неверным: там я стучался по имени
 * с подчёркиванием и получал 404, а по верному адресу (`flux.1-dev`, с точкой)
 * сервер отвечает 422 — то есть доступ есть, но тело запроса другое. Здесь
 * сначала выясняем, какие поля сервер ждёт (он сам их перечисляет), потом
 * пробуем получить изображение и сохранить его на диск.
 *
 * Ключ нигде не печатается.
 */
import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("/home/ibrohim/kadr/.env", "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);
const key = env.NVIDIA_API_KEY;
const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" };

const PROMPT =
  "Flat hand-drawn stick figure standing on a white background, thick trembling black outline, flat color fill, lots of white space";

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text().catch(() => "");
  return { status: response.status, text };
}

/** Сохраняет картинку из ответа: сервер может отдать base64 или ссылку. */
function extractImage(text) {
  try {
    const data = JSON.parse(text);
    const base64 =
      data?.artifacts?.[0]?.base64 ??
      data?.data?.[0]?.b64_json ??
      data?.image ??
      data?.images?.[0]?.image ??
      null;
    if (base64) return { kind: "base64", value: base64 };
    const url = data?.artifacts?.[0]?.url ?? data?.data?.[0]?.url ?? null;
    if (url) return { kind: "url", value: url };
  } catch {
    /* ответ мог быть не JSON */
  }
  return null;
}

const GENAI = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev";

console.log("── 1. какие поля ждёт здешний FLUX (сервер перечисляет сам) ──");
const empty = await post(GENAI, {});
console.log(`пустое тело → ${empty.status}: ${empty.text.slice(0, 600)}`);

console.log("\n── 2. пробуем осмысленные тела ──");
const BODIES = [
  ["только промт", { prompt: PROMPT }],
  ["промт + режим", { prompt: PROMPT, mode: "base" }],
  ["промт + режим + шаги", { prompt: PROMPT, mode: "base", steps: 30, seed: 0, cfg_scale: 3.5 }],
  ["без cfg_scale (он ≤ 0?)", { prompt: PROMPT, mode: "base", steps: 30, seed: 0 }],
  ["пониженный cfg", { prompt: PROMPT, mode: "base", steps: 30, seed: 0, cfg_scale: 0 }],
  ["aspect_ratio вместо ratio", { prompt: PROMPT, mode: "base", steps: 30, seed: 0, aspect_ratio: "16:9" }],
];

let saved = 0;
for (const [label, body] of BODIES) {
  const answer = await post(GENAI, body);
  const image = answer.status < 300 ? extractImage(answer.text) : null;
  if (image) {
    if (image.kind === "base64") {
      const file = `/home/ibrohim/.kadr-probe/nvidia-image-${++saved}.png`;
      writeFileSync(file, Buffer.from(image.value, "base64"));
      console.log(`✔ ${label}: ${answer.status}, картинка сохранена → ${file}`);
    } else {
      console.log(`✔ ${label}: ${answer.status}, сервер вернул ссылку: ${image.value.slice(0, 120)}`);
      const response = await fetch(image.value, { signal: AbortSignal.timeout(120_000) });
      const file = `/home/ibrohim/.kadr-probe/nvidia-image-${++saved}.png`;
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      console.log(`  скачано → ${file} (${response.status})`);
    }
    break; // одного рабочего тела достаточно
  }
  console.log(`✖ ${label}: ${answer.status} ${answer.text.slice(0, 260)}`);
}

console.log("\n── 3. второй вход: OpenAI-совместимый images/generations ──");
for (const [label, body] of [
  ["model + prompt", { model: "black-forest-labs/flux.1-dev", prompt: PROMPT, n: 1, size: "1024x1024" }],
  ["model flux.1-schnell", { model: "black-forest-labs/flux.1-schnell", prompt: PROMPT, n: 1 }],
  ["model qwen-image", { model: "qwen/qwen-image", prompt: PROMPT, n: 1 }],
]) {
  const answer = await post("https://integrate.api.nvidia.com/v1/images/generations", body);
  const image = answer.status < 300 ? extractImage(answer.text) : null;
  if (image?.kind === "base64") {
    const file = `/home/ibrohim/.kadr-probe/nvidia-image-${++saved}.png`;
    writeFileSync(file, Buffer.from(image.value, "base64"));
    console.log(`✔ ${label}: ${answer.status}, картинка → ${file}`);
    break;
  }
  console.log(`✖ ${label}: ${answer.status} ${answer.text.slice(0, 240)}`);
}

console.log(`\nитог: сохранено картинок — ${saved}`);
