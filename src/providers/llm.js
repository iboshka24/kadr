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

async function callGroq({ system, user, env, json = true, temperature = 0.85 }) {
  const key = env.GROQ_API_KEY;
  if (!key) throw new LlmUnavailable("нет GROQ_API_KEY");
  const model = env.GROQ_MODEL_TEXT || "llama-3.3-70b-versatile";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
  });
  const text = await res.text();
  if (res.status === 429) throw new LlmUnavailable("Groq: квота исчерпана (429)");
  if (!res.ok) throw new Error(`Groq ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const out = data?.choices?.[0]?.message?.content ?? "";
  if (!out.trim()) throw new Error("Groq вернул пустой ответ");
  return out;
}

/**
 * Спрашивает модель и возвращает разобранный JSON.
 * Провайдеры перебираются по кругу; отказ по квоте не считается ошибкой стадии.
 */
export async function askJson({ system, user, env = loadEnv(), json = true, temperature = 0.85, attempts = 2 }) {
  const providers = [
    ["gemini", callGemini],
    ["groq", callGroq],
  ];
  const problems = [];

  for (const [name, call] of providers) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const text = await call({ system, user, env, json, temperature });
        return json ? extractJson(text) : text;
      } catch (err) {
        const quota = err instanceof LlmUnavailable || /квота|429/.test(err.message);
        problems.push(`${name}: ${err.message}`);
        if (!quota && attempt < attempts) await sleep(1500 * attempt);
        if (quota) break; // на этом провайдере делать нечего — идём к следующему
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
