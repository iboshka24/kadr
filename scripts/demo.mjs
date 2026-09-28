/**
 * Прогон всего конвейера на одной реальной теме.
 *
 * Стадии идут в том же порядке, что у большого видео: замысел → паспорт стиля →
 * параметры → сценарий → промты картинок → промты анимаций → озвучка с
 * таймингами → сборка. Отличие одно: длина взята в полторы минуты, чтобы прогон
 * уложился в несколько минут. Восьмиминутное видео считается этим же кодом, там
 * просто больше кадров.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { loadEnv, providersAvailable } from "../src/providers/llm.js";
import { synthesize, alignShots } from "../src/providers/voice.js";
import { assemble, describeFilm } from "../src/assemble.js";
import {
  stageStyle,
  stageParams,
  stageNiche,
  stageScript,
  stageImagePrompts,
  stageVideoPrompts,
} from "../src/stages/index.js";

const PROJECT = "ponchik";
const OUT = join("/home/ibrohim/kadr/projects", PROJECT);
const MINUTES = 1.5;
mkdirSync(OUT, { recursive: true });

const env = loadEnv();
console.log("провайдеры:", providersAvailable(env));

const step = (name) => console.log(`\n── ${name} ──`);
const save = (name, data) => writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2), "utf8");

/** Готовую стадию не пересчитываем: у модели есть квота, и она не бесконечная. */
const FORCE = process.env.KADR_FORCE === "1";
const cached = (name) => {
  const file = join(OUT, `${name}.json`);
  if (FORCE || !existsSync(file)) return null;
  console.log(`  (беру готовое: ${name}.json)`);
  return JSON.parse(readFileSync(file, "utf8"));
};

// Замысел вводим прямо здесь: транскрипта референса у нас пока нет, а проверять
// конвейер надо на настоящем материале, а не на пустышке.
const idea = {
  title: "Почему пончик стоит дешевле, чем ты думаешь",
  hook: "В одном пончике сорок граммов сахара. И это не ошибка рецепта.",
  essence:
    "Дешёвая еда спроектирована так, чтобы её нельзя было съесть одну: сахар, жир и соль подобраны в пропорции, которая обходит сигнал сытости.",
  why: "Обыденная вещь, спрятанный механизм, чувство «мной управляли» — ядро ниши.",
};

const referenceNotes = `Референсы канала: плоская рисованная от руки графика, человечки-палочки с круглыми
головами без лиц, толстый слегка дрожащий чёрный контур, заливки плоскими цветами без градиентов и теней,
много белого фона и пустого места, один-два предмета в кадре, никакого текста внутри картинки.`;

let style, params, concept, script, imagePrompts, videoPrompts;

step("1. Паспорт стиля");
style = { output: cached("style"), errors: [], warnings: [] };
if (!style.output) {
style = await stageStyle({ referenceNotes, env, language: "ru" });
if (style.errors.length) console.log("замечания:", style.errors);
save("style", style.output);
console.log("блок стиля:", String(style.output.styleBlock).slice(0, 120) + "…");
console.log("персонажей в листе:", style.output.characterSheet?.length ?? 0);
}

step("2. Параметры");
params = { output: cached("params"), errors: [], warnings: [] };
if (!params.output) params = await stageParams({ minutes: MINUTES, language: "ru" });
save("params", params.output);
console.log(
  `слов ${params.output.wordsTarget.join("–")}, кадров ${params.output.shotsTarget.join("–")}, ` +
    `анимаций ${params.output.animationTarget.join("–")}, голос ${params.output.voice}`,
);

step("3. Замысел");
concept = { output: cached("concept"), errors: [], warnings: [] };
if (!concept.output) concept = await stageNiche({ idea, analysis: { niche: "видео-эссе со спрятанным механизмом" }, env });
if (concept.errors.length) console.log("замечания:", concept.errors);
save("concept", concept.output);
console.log("механизм:", String(concept.output.mechanism ?? "").slice(0, 140) + "…");

step("4. Сценарий");
script = { output: cached("script"), errors: [], warnings: [] };
if (!script.output) script = await stageScript({ concept: concept.output, params: params.output, style: style.output, env });
save("script", script.output);
console.log("кадров:", script.output.shots.length, "| слов:", script.output.stats.words);
console.log("анимаций:", script.output.stats.animated);
console.log("замечания проверки:", script.errors.length ? script.errors.slice(0, 4) : "нет");

step("5. Промты картинок");
imagePrompts = { output: cached("image_prompts"), errors: [], warnings: [] };
if (!imagePrompts.output) imagePrompts = await stageImagePrompts({ shots: script.output.shots, style: style.output, env, batch: 12 });
save("image_prompts", imagePrompts.output);
console.log("промтов:", imagePrompts.output.prompts.length, "| нарушения:", imagePrompts.errors.slice(0, 3));

step("6. Промты анимаций");
videoPrompts = { output: cached("video_prompts"), errors: [], warnings: [] };
if (!videoPrompts.output) videoPrompts = await stageVideoPrompts({
  shots: script.output.shots,
  style: style.output,
  imagePrompts: imagePrompts.output.prompts,
  env,
});
save("video_prompts", videoPrompts.output);
console.log("промтов анимации:", videoPrompts.output.prompts.length, "| нарушения:", videoPrompts.errors.slice(0, 3));

step("7. Озвучка");
const narration = script.output.shots.map((s) => s.narration).join(" ");
const voice = await synthesize({ text: narration, outDir: join(OUT, "voice"), voice: params.output.voice });
console.log(
  `звука ${(voice.audio ? "есть" : "нет")}, слов с таймингом: ${voice.words.length}, ` +
    `длительность ${(voice.durationMs / 1000).toFixed(1)} с`,
);

const timed = alignShots(script.output.shots, voice.words);
save("timed_shots", timed);

step("8. Сборка");
const film = describeFilm(
  assemble({ shots: timed, voicePath: voice.audio, words: voice.words, outDir: join(OUT, "video") }),
);
save("film", film);
console.log(`файл: ${film.video}`);
console.log(`длительность ${film.seconds} с, клипов ${film.clipsCount}, вес ${film.megabytes} МБ`);
