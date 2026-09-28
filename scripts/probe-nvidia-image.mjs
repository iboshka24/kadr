/**
 * Проба генерации изображений и видео у NVIDIA — по правильным адресам.
 *
 * Прошлая проба была неверной: я стучался на `integrate.api.nvidia.com` (там
 * текстовые модели) и брал имя с подчёркиванием. Генерация живёт на отдельном
 * хосте `ai.api.nvidia.com/v1/genai/<издатель>/<модель>`, и имя модели пишется
 * так, как оно записано на странице модели.
 *
 * Печатаем только коды и текст ответа сервера — ключ нигде не выводится.
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
if (!key) {
  console.log("нет NVIDIA_API_KEY");
  process.exit(1);
}

/** Кандидаты: картинки, редактирование картинок, видео. */
const CANDIDATES = [
  ["картинки Qwen", "https://ai.api.nvidia.com/v1/genai/qwen/qwen-image"],
  ["Qwen правка", "https://ai.api.nvidia.com/v1/genai/qwen/qwen-image-edit"],
  ["FLUX с точкой", "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev"],
  ["FLUX schnell", "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell"],
  ["FLUX с подчёркиванием (как пробовал)", "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux_1-dev"],
  ["SDXL", "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-xl"],
  ["SD 3 medium", "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium"],
  ["видео Wan", "https://ai.api.nvidia.com/v1/genai/wan-ai/wan2.2-t2v-a14b"],
  ["видео Cosmos", "https://ai.api.nvidia.com/v1/genai/nvidia/cosmos-1.0-diffusion-7b-text2world"],
  ["видео SVD", "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-video-diffusion"],
  ["старый images host", "https://integrate.api.nvidia.com/v1/images/generations"],
];

const body = { prompt: "a stick figure standing, simple line drawing", mode: "base", ratio: "16:9", cfg_scale: 3.5, steps: 30, seed: 0 };

for (const [label, url] of CANDIDATES) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text().catch(() => "");
    // Ошибку доступа сервер называет сам — это и есть ответ на вопрос.
    const hint = text.slice(0, 180).replace(/\s+/g, " ");
    const marks = response.ok ? "✔" : response.status === 404 ? "·" : "✖";
    console.log(`${marks} ${label.padEnd(42)} ${response.status}  ${hint}`);
  } catch (error) {
    console.log(`✖ ${label.padEnd(42)} не дошло: ${String(error?.message ?? error).slice(0, 80)}`);
  }
}

// Заодно: что вообще перечисляет каталог моделей генерации.
try {
  const response = await fetch("https://ai.api.nvidia.com/v1/genai/models", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  console.log(`\nкаталог моделей генерации: ${response.status} ${(await response.text()).slice(0, 300)}`);
} catch (error) {
  console.log(`\nкаталог моделей генерации: не дошло (${String(error?.message ?? error).slice(0, 60)})`);
}
