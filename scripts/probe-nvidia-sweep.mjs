/**
 * Перебор имён моделей генерации у NVIDIA: какие пути вообще существуют.
 *
 * Различать надо три ответа, и это ключ ко всему разбору:
 *   422 или 400 — путь существует, но тело запроса иное (значит, доступ есть);
 *   404 «page not found» — такого пути нет (имя модели неверное);
 *   404 с «Function … not found for account» — модель есть, но аккаунту не выдан доступ.
 *
 * Поэтому перебор осмысленный: мы ищем, где сервер ругается на тело, а не на путь.
 */
import { readFileSync } from "node:fs";

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

/** Проверяемое: картинки, правка картинок, видео. */
const CANDIDATES = [
  // точно работает — держим как эталон
  "black-forest-labs/flux.1-dev",
  // Qwen — про него говорил пользователь
  "qwen/qwen-image",
  "qwen/qwen-image-edit",
  "qwen-image/qwen-image",
  "nvidia/qwen-image",
  "qwen/qwen-image-2512",
  "qwen/qwen-image-edit-2509",
  // видео
  "wan-ai/wan2.1-t2v-14b",
  "wan-ai/wan2.2-t2v-a14b",
  "wan-ai/wan2.2-i2v-a14b",
  "nvidia/wan2.1-t2v-14b",
  "nvidia/cosmos-predict2-14b-text2world",
  "nvidia/cosmos-predict1-7b-text2world",
  "nvidia/cosmos1-diffusion-7b-text2world",
  "lightricks/ltx-video",
  "ltx/ltx-video-2b",
  "stabilityai/stable-video-diffusion",
  "nvidia/stable-video-diffusion",
  "minimax/hailuo-02",
  "minimaxai/minimax-hailuo-02",
  "google/veo-3",
  "pika/pika-2.2",
  "kling/kling-v2",
  // прочие картинки, чтобы понимать масштаб доступа
  "stabilityai/stable-diffusion-3-medium",
  "black-forest-labs/flux.1-schnell",
  "black-forest-labs/flux.2-dev",
];

const BODY = { prompt: "a stick figure standing on white background, simple line drawing" };
const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" };

const verdict = (status, text) => {
  if (status === 200) return "✔ РАБОТАЕТ";
  if (status === 422 || status === 400) return "≈ путь есть (тело другое)";
  if (status === 401 || status === 403) return "✖ нет доступа";
  if (text.includes("not found for account")) return "≈ модель есть, аккаунту не выдана";
  if (text.includes("page not found")) return "· нет такого пути";
  return `? ${status}`;
};

const rows = [];
for (const id of CANDIDATES) {
  const url = `https://ai.api.nvidia.com/v1/genai/${id}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(BODY),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text().catch(() => "");
    const mark = verdict(response.status, text);
    rows.push([id, response.status, mark, text.slice(0, 110).replace(/\s+/g, " ")]);
    console.log(`${mark.padEnd(30)} ${String(response.status).padEnd(4)} ${id}`);
  } catch (error) {
    console.log(`${"✖ не дошло".padEnd(30)} ---- ${id} — ${String(error?.message ?? error).slice(0, 60)}`);
  }
}

console.log("\n── подробности по тем, где путь существует ──");
for (const [id, status, mark, text] of rows.filter(([, , m]) => m.startsWith("≈") || m.startsWith("✔"))) {
  console.log(`\n${id} → ${status} (${mark})\n  ${text}`);
}
