/**
 * Проба NVIDIA: годится ли ключ для картинок и что вообще доступно.
 *
 * Проверяем два разных входа, потому что NVIDIA держит их параллельно: старый
 * genai-эндпоинт (отдаёт картинку в base64 внутри JSON) и новый совместимый с
 * OpenAI. Что ответит — то и станет провайдером; гадать тут нельзя, у каждого
 * свои имена полей и своя обработка отказа.
 *
 * Ключ читается из окружения и в вывод не попадает.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";

const OUT = new URL("../.kadr-probe/", import.meta.url).pathname.replace(/\/$/, "");
mkdirSync(OUT, { recursive: true });

// .env читаем сами: зависимостей у проекта нет
const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const KEY = env.NVIDIA_API_KEY;
const BASE = env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
console.log("ключ есть:", Boolean(KEY), "| длина:", KEY?.length ?? 0);
console.log("база:", BASE);

const PROMPT =
  "flat 2D hand-drawn cartoon illustration, bold slightly uneven black ink outlines, " +
  "naive doodle explainer style, a minimalist stick figure with a round white head sitting at a table " +
  "with a donut, flat solid color fills, plain white background, lots of empty negative space, " +
  "16:9 horizontal composition, centered subject";

async function tryOpenAiCompatible() {
  const url = `${BASE}/images/generations`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ model: "black-forest-labs/flux_1-dev", prompt: PROMPT, n: 1, size: "1024x576", response_format: "b64_json" }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  const b64 = json?.data?.[0]?.b64_json;
  console.log(`\n[совместимый с OpenAI] ${res.status} ${res.headers.get("content-type")?.slice(0, 40)}`);
  if (b64) {
    writeFileSync(`${OUT}/flux-openai.png`, Buffer.from(b64, "base64"));
    console.log("  картинка получена, байт:", Buffer.from(b64, "base64").length);
  } else {
    console.log("  ответ:", text.slice(0, 300));
  }
}

async function tryGenai() {
  const url = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux_1-dev";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ prompt: PROMPT, mode: "base", ratio: "16:9", cfg_scale: 3.5, steps: 40, seed: 0 }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  const b64 = json?.artifacts?.[0]?.base64;
  console.log(`\n[genai] ${res.status} ${res.headers.get("content-type")?.slice(0, 40)}`);
  if (b64) {
    writeFileSync(`${OUT}/flux-genai.png`, Buffer.from(b64, "base64"));
    console.log("  картинка получена, байт:", Buffer.from(b64, "base64").length);
  } else {
    console.log("  ответ:", text.slice(0, 300));
  }
}

async function listModels() {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  const ids = (json?.data ?? []).map((m) => m.id);
  console.log(`\n[модели] ${res.status}, всего: ${ids.length}`);
  const interesting = ids.filter((id) => /flux|image|video|cosmos|sd|stable|vision|ltx|wan|seedance/i.test(id));
  console.log("  про картинки и видео:", interesting.length ? interesting.slice(0, 25).join("\n    ") : text.slice(0, 200));
}

for (const task of [tryOpenAiCompatible, tryGenai, listModels]) {
  try { await task(); } catch (err) { console.log(`  ОШИБКА: ${err.message}`); }
}
