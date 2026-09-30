/**
 * Озвучка.
 *
 * Бесплатный голос Microsoft Edge Neural: без ключа, без счёта, 322 голоса,
 * из них два русских. Проверено вживую — на одну фразу приходит ~43 КБ mp3 и
 * пословные тайминги с точностью до миллисекунды.
 *
 * Тайминги здесь не роскошь: субтитры и смена панели синхронизируются по ним, а
 * не по «примерно на глазок». Поэтому голос отдаёт не только звук, но и карту
 * слов — дальше по ней режется видео.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "edge_tts_bridge.py");

export class VoiceError extends Error {}

/** Кто говорит. Русских голосов в сервисе ровно два — и это весь выбор. */
export const VOICES = {
  ru: [
    { id: "ru-RU-DmitryNeural", name: "Дмитрий", gender: "male", note: "глубокий, спокойный — для рассказа от третьего лица" },
    { id: "ru-RU-SvetlanaNeural", name: "Светлана", gender: "female", note: "мягкий преподавательский" },
  ],
  en: [
    { id: "en-US-GuyNeural", name: "Guy", gender: "male", note: "документальный" },
    { id: "en-US-AriaNeural", name: "Aria", gender: "female", note: "ровный, нейтральный" },
    { id: "en-GB-RyanNeural", name: "Ryan", gender: "male", note: "британский" },
  ],
};

function runBridge(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [BRIDGE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new VoiceError(err.trim().split("\n").slice(-3).join(" ") || `код ${code}`));
    });
  });
}

/**
 * Озвучивает текст и возвращает пути к звуку и к карте слов.
 * @returns {Promise<{audio:string, wordsPath:string, words:Array, durationMs:number}>}
 */
export async function synthesize({ text, outDir, voice = "ru-RU-DmitryNeural", rate = "-3%" }) {
  if (!String(text ?? "").trim()) throw new VoiceError("нечего озвучивать: текст пуст");
  mkdirSync(outDir, { recursive: true });

  // Запасные голоса того же языка: основной (сегодня это Дмитрий) может перестать
  // отдавать звук, и мост возьмёт следующий живой вместо падения стадии.
  const lang = String(voice).slice(0, 2);
  const fallbacks = (VOICES[lang] ?? []).map((v) => v.id).filter((id) => id !== voice);

  const textFile = join(outDir, "voice.txt");
  const mp3 = join(outDir, "voice.mp3");
  const wordsPath = join(outDir, "words.json");
  writeFileSync(textFile, text, "utf8");

  // Значение вида «-3%» argparse принимает за ещё один ключ, если передать его
  // отдельным словом. Поэтому склеиваем «ключ=значение».
  const report = await runBridge([
    `--text-file=${textFile}`,
    `--voice=${voice}`,
    `--rate=${rate}`,
    // Запасные голоса: выбранный голос может перестать отвечать в любой момент,
    // и мост сам переключится на живой, а не уронит стадию.
    `--fallbacks=${fallbacks.join(",")}`,
    `--out-mp3=${mp3}`,
    `--out-json=${wordsPath}`,
  ]);

  let meta = {};
  try { meta = JSON.parse(report.split("\n").pop()); } catch { /* мост мог напечатать лишнее */ }
  const words = JSON.parse(readFileSync(wordsPath, "utf8")).words ?? [];

  // Возвращаем голос, который реально говорил: он мог быть подменён на запасной.
  return { audio: mp3, wordsPath, words, durationMs: meta.durationMs ?? 0, voice: meta.voice ?? voice, chunks: meta.chunks ?? 0 };
}

/**
 * Режет тайминги слов по границам кадров: каждому кадру — свой отрезок времени.
 * Так смена картинки попадает в паузу между фразами, а не в середину слова.
 */
export function alignShots(shots, words) {
  if (!words.length) return shots.map((s) => ({ ...s, startMs: 0, endMs: 0 }));
  const wordCount = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).length;

  const counts = shots.map((shot) => Math.max(1, wordCount(shot.narration)));
  const total = counts.reduce((sum, n) => sum + n, 0);
  const last = words[words.length - 1];
  const durationMs = last.startMs + last.durMs;

  // Таймингов приходит меньше, чем слов в сценарии: сервис не отдаёт границы для
  // чисел и знаков (на живом ролике — 2748 против 2814). Прежний счёт «взять ровно
  // столько слов, сколько в кадре» уводил курсор за конец списка, и последние кадры
  // получали начало 0 и конец всего фильма: один кадр растягивался на двадцать минут
  // и рисовался в 4K. Поэтому, когда таймингов не хватило, место кадра берётся по
  // доле сказанного, а не по абсолютному счёту слов, — так ошибка не накапливается.
  let cursor = 0;
  let cum = 0;
  let previousEnd = 0;
  return shots.map((shot, index) => {
    const take = counts[index];
    const slice = words.slice(cursor, cursor + take);
    cum += take;
    cursor += take;

    const shareStart = Math.round((durationMs * (cum - take)) / total);
    const shareEnd = Math.round((durationMs * cum) / total);

    // Начало не может уйти назад: у кадра с таймингами оно берётся из речи, а у кадра
    // без таймингов — из доли сказанного, и эти две оценки расходятся. Без этой
    // поправки кадр начинался раньше конца предыдущего, и клипы накладывались.
    const candidateStart = index === 0 ? 0 : (slice[0]?.startMs ?? shareStart);
    const startMs = Math.max(candidateStart, previousEnd);
    const nextStart = words[cursor]?.startMs ?? shareEnd;
    const endMs = Math.max(startMs + 400, Math.min(nextStart || shareEnd, durationMs));
    previousEnd = endMs;
    // Последнему кадру отдаём всё оставшееся время: иначе он обрывает видео.
    const lastEnd = index === shots.length - 1 ? Math.max(endMs, durationMs) : endMs;
    return { ...shot, startMs, endMs: lastEnd, words: slice };
  });
}

/** Субтитры SRT по таймингам слов: строки собираются по 6-7 слов. */
export function toSrt(words, { maxWords = 7 } = {}) {
  const lines = [];
  for (let i = 0, n = 1; i < words.length; i += maxWords, n += 1) {
    const chunk = words.slice(i, i + maxWords);
    const start = chunk[0].startMs;
    const last = chunk[chunk.length - 1];
    const end = last.startMs + last.durMs;
    lines.push(
      `${n}\n${stamp(start)} --> ${stamp(end)}\n${chunk.map((w) => w.word).join(" ")}\n`,
    );
  }
  return lines.join("\n");
}

function stamp(ms) {
  const total = Math.max(0, ms);
  const h = String(Math.floor(total / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((total % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((total % 60_000) / 1000)).padStart(2, "0");
  const milli = String(Math.floor(total % 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${milli}`;
}
