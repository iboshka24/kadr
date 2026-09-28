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
import { collectPanels } from "../src/providers/image.js";
import { assemble, describeFilm } from "../src/assemble.js";
import {
  stageIdeas,
  stageStyle,
  stageParams,
  stageNiche,
  stageScript,
  stageImagePrompts,
  stageVideoPrompts,
} from "../src/stages/index.js";

// Проект, длина и язык берутся из окружения: тем же кодом делается и русское
// видео, и английское, и любое другое — без второй копии конвейера.
const PROJECT = process.env.KADR_PROJECT ?? "ponchik";
const OUT = join("/home/ibrohim/kadr/projects", PROJECT);
const MINUTES = Number(process.env.KADR_MINUTES ?? 1.5);
const LANGUAGE = process.env.KADR_LANG ?? "ru";
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
const TOPIC = process.env.KADR_TOPIC ?? "";

const idea = {
  title: process.env.KADR_IDEA_TITLE ?? "Почему пончик стоит дешевле, чем ты думаешь",
  hook: process.env.KADR_IDEA_HOOK ?? "В одном пончике сорок граммов сахара. И это не ошибка рецепта.",
  essence:
    process.env.KADR_IDEA_ESSENCE ??
    "Дешёвая еда спроектирована так, чтобы её нельзя было съесть одну: сахар, жир и соль подобраны в пропорции, которая обходит сигнал сытости.",
  why: "Обыденная вещь, спрятанный механизм, чувство «мной управляли» — ядро ниши.",
};

// Стиль берём из референсов канала. Мультяшный, как на присланных кадрах:
// город и здания прямо, светлое небо, тёплые плоские цвета, а название места
// нарисовано прямо в кадре — оно и держит ощущение конкретного города.
const referenceNotes = process.env.KADR_STYLE_NOTES ?? `Язык канала снят с присланных кадров. Мультяшная рисованная графика двух видов фона:
чистый белый лист и плоская ночная синева.

Человек нарисован палочками: круглая голова, точки-глаза, линия рта, простые палочки-руки и ноги.
Лица живые, поза выразительная, часто нелепая. Никакого фотореализма и никаких детальных лиц.

Подписи — фирменный приём канала. Красная стрелка указывает на предмет, рядом жирная чёрная
надпись большими буквами прямо в кадре (как «CULTURE» над младенцем у костра). Стрелка и подпись
входят в картинку, а не добавляются потом.

Даты и числа — отдельной плашкой в углу кадра (как «Nov 2021»), будто выписка из документа:
она подтверждает факт и держит доверие.

Отдельный вид кадра — натюрморт из предметов сцены без людей: микрофон на стойке, гитара,
прислонённая к табурету с губной гармошкой, пластинка в рамке на стене.

Жирный чёрный контур, плоские заливки без градиентов и теней. Для ночных сцен — тёмно-синее небо,
звёзды, силуэты гор, костёр в центре. Много пустого места, один сюжет на кадр.`;

let style, params, concept, script, imagePrompts, videoPrompts;

// Если задана только тема, идеи придумывает модель — и берём первую.
let invented = null;
if (TOPIC && !process.env.KADR_IDEA_TITLE) {
  step("0. Идеи по теме (придумывает модель)");
  const cachedIdeas = cached("ideas");
  if (cachedIdeas) {
    invented = cachedIdeas;
  } else {
    const result = await stageIdeas({ topic: TOPIC, env });
    if (result.errors.length) console.log("замечания:", result.errors.slice(0, 3));
    invented = result.output;
    save("ideas", invented);
  }
  invented.ideas.slice(0, 8).forEach((it, i) => console.log(`  ${i + 1}. ${it.title}`));
  const chosen = invented.ideas[Number(process.env.KADR_IDEA_INDEX ?? 0)];
  console.log(`выбрана: ${chosen.title}`);
  Object.assign(idea, {
    title: chosen.title,
    hook: chosen.hook,
    essence: chosen.mechanism,
    why: chosen.finalTurn,
    mechanism: chosen.mechanism,
    villain: chosen.villain,
    finalTurn: chosen.finalTurn,
    facts: chosen.facts,
  });
}

step("1. Паспорт стиля");
style = { output: cached("style"), errors: [], warnings: [] };
if (!style.output) {
style = await stageStyle({ referenceNotes, env, language: LANGUAGE });
if (style.errors.length) console.log("замечания:", style.errors);
save("style", style.output);
console.log("блок стиля:", String(style.output.styleBlock).slice(0, 120) + "…");
console.log("персонажей в листе:", style.output.characterSheet?.length ?? 0);
}

step("2. Параметры");
params = { output: cached("params"), errors: [], warnings: [] };
if (!params.output) params = await stageParams({ minutes: MINUTES, language: LANGUAGE });
save("params", params.output);
console.log(
  `слов ${params.output.wordsTarget.join("–")}, кадров ${params.output.shotsTarget.join("–")}, ` +
    `анимаций ${params.output.animationTarget.join("–")}, голос ${params.output.voice}`,
);

step("3. Замысел");
concept = { output: cached("concept"), errors: [], warnings: [] };
if (!concept.output) concept = await stageNiche({
    idea: { ...idea, ...(invented?.ideas?.[Number(process.env.KADR_IDEA_INDEX ?? 0)] ?? {}) },
    analysis: { niche: "видео-эссе со спрятанным механизмом" },
    env,
  });
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
  `звука ${voice.audio ? "есть" : "нет"}, слов с таймингом: ${voice.words.length}, ` +
    `длительность ${(voice.durationMs / 1000).toFixed(1)} с, ` +
    `голос ${voice.voice}${voice.voice === params.output.voice ? "" : " (запасной — основной не отвечал)"}, ` +
    `кусков ${voice.chunks}`,
);

const timed = alignShots(script.output.shots, voice.words);
save("timed_shots", timed);

step("8. Картинки для кадров");
const panels = await collectPanels({
  projectDir: OUT,
  shots: script.output.shots,
  prompts: imagePrompts.output.prompts,
  env,
  log: (line) => console.log(line),
});
console.log(`готовых картинок ${panels.rendered.size} из ${script.output.shots.length}, источник: ${panels.provider}`);

step("9. Сборка");
const film = describeFilm(
  assemble({
    shots: timed,
    voicePath: voice.audio,
    words: voice.words,
    outDir: join(OUT, "video"),
    rendered: panels.rendered,
  }),
);
save("film", film);
console.log(`файл: ${film.video}`);
console.log(`длительность ${film.seconds} с, клипов ${film.clipsCount}, вес ${film.megabytes} МБ`);
