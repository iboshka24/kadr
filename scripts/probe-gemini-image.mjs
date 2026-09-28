/**
 * Проба Gemini: даёт ли ключ картинки и какие модели вообще доступны.
 *
 * NVIDIA для рисования не годится (только текст), поэтому проверяем второй
 * бесплатный путь. Смотрим список моделей ключа, потом пробуем генерацию
 * изображения — и сохраняем то, что вернулось, чтобы это можно было увидеть
 * глазами, а не поверить в success.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = "/home/ibrohim/.kadr-probe";
mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync("/home/ibrohim/kadr/.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const KEY = env.GEMINI_API_KEY;
const API = "https://generativelanguage.googleapis.com/v1beta";

const PROMPT =
  "Flat 2D hand-drawn cartoon illustration, bold slightly uneven black ink outlines, naive doodle " +
  "explainer style. A minimalist stick figure with a round white head sits at a table with a single " +
  "donut. Flat solid color fills, no gradients, plain white background, lots of empty negative space. " +
  "16:9 horizontal composition, centered subject.";

async function listModels() {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": KEY } });
  const json = await res.json().catch(() => null);
  const models = json?.models ?? [];
  console.log(`[модели Gemini] ${res.status}, всего: ${models.length}`);
  const imageish = models
    .map((m) => m.name.replace("models/", ""))
    .filter((n) => /image|imagen|banana|vision/i.test(n));
  console.log("  могут рисовать:", imageish.length ? imageish.join(", ") : "—");
  const flash = models.map((m) => m.name.replace("models/", "")).filter((n) => /flash|pro/.test(n));
  console.log("  текстовые (первые 10):", flash.slice(0, 10).join(", "));
  return models.map((m) => m.name.replace("models/", ""));
}

async function tryImage(model) {
  const res = await fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }

  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  console.log(`\n[картинка через ${model}] ${res.status}`);
  if (img) {
    const buf = Buffer.from(img.inlineData.data, "base64");
    const ext = (img.inlineData.mimeType || "image/png").includes("png") ? "png" : "jpg";
    const path = `${OUT}/gemini-panel.${ext}`;
    writeFileSync(path, buf);
    console.log(`  ПОЛУЧИЛОСЬ: байт ${buf.length}, ${img.inlineData.mimeType}`);
    console.log("  файл:", path);
    return true;
  }
  console.log("  ответ:", text.slice(0, 400));
  return false;
}

const models = await listModels().catch((e) => {
  console.log("список моделей не получен:", e.message);
  return [];
});

// Пробуем по очереди всё, что похоже на генератор картинок, плюс известные имена.
const candidates = [
  ...models.filter((m) => /image|imagen/i.test(m)),
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-preview-image-generation",
  "imagen-4.0-generate-001",
];

let done = false;
for (const model of [...new Set(candidates)].slice(0, 6)) {
  if (done) break;
  try {
    done = await tryImage(model);
  } catch (err) {
    console.log(`  ${model}: ошибка ${err.message}`);
  }
}
if (!done) console.log("\nкартинку через Gemini получить не удалось");
