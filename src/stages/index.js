/**
 * Стадии конвейера.
 *
 * Каждая стадия — чистая функция «вход → выход»: берёт материалы проекта,
 * возвращает результат и список нарушений. Так их можно проверять по одной, а не
 * гадать, где сломалось длинное видео.
 *
 * Модель здесь не автор, а исполнитель: она пишет текст, но правила (сколько
 * слов, сколько кадров, где анимация, какой блок стиля) задаёт код и проверяет
 * тоже код. Поэтому у стадий сценария и промтов есть петля починки: если
 * проверка нашла нарушение, замечания уходят обратно модели вместе с её
 * прежним ответом.
 */
import { askJson } from "../providers/llm.js";
import { checkStage, planFor } from "../validate.js";

/** Общий хребет ниши: он одинаков для всех видео канала. */
export const NICHE_DNA = `Ниша: короткие видео-эссе на 6–9 минут. Берётся обыденная вещь или привычный вопрос
(еда, тело, деньги, привычка, общество) и вскрывается спрятанный механизм — так, чтобы зритель
почувствовал: «мной управляли, а я не знал, вот доказательства».
Тон: спокойный, холодный, чуть зловещий, как триллер-расследование. Без клоунады и без
восклицаний. Обращение к зрителю на «ты». Финал переворачивает взгляд на собственную жизнь.
Формула: (1) холодный заход с конкретной странной деталью; (2) имя или разгадка придерживается;
(3) контраст «в природе X — сейчас Y»; (4) конкретика для доверия: имена, годы, числа, суммы;
(5) лестница раскрытий, каждый слой страшнее; (6) поворот к системе или интересy, который на этом
заработал; (7) одна кинематографичная сцена-эпизод; (8) финал про жизнь зрителя.`;

const SYSTEM_WRITER = `${NICHE_DNA}

Ты пишешь текст для озвучки, а не статью: короткие фразы, живая речь, без списков и без
заголовков. Отвечай только JSON без пояснений вокруг.`;

/** 1. Транскрипт: разбор эталона и проверка формулы. */
export async function stageTranscript({ transcript, env }) {
  const data = await askJson({
    env,
    system: `${NICHE_DNA}
${NICHE_RESEARCH}

Тебе дали транскрибацию референсного видео из этой ниши. Разбери её как ремесленник, а не как
зритель. Отвечай только JSON.`,
    user: `Транскрипт референса:
"""
${transcript}
"""

Верни JSON:
{
  "niche": "как называется эта ниша и в чём её суть, 2–3 предложения",
  "tone": "какой тон и какая манера речи",
  "formula": ["шаг", "шаг", "..."],
  "tempo": { "wordsTotal": число, "approxMinutes": число, "wordsPerMinute": число },
  "hooksUsed": ["конкретные фразы-хуки из транскрипта"],
  "ideas": [
    { "title": "рабочий заголовок", "hook": "первая фраза, дословно как бы она звучала",
      "essence": "суть в одном-двух предложениях", "why": "почему это заходит в этой нише" }
  ]
}`,
  });
  const ideas = Array.isArray(data.ideas) ? data.ideas.slice(0, 8) : [];
  const errors = ideas.length < 6 ? ["идей меньше шести"] : [];
  return { output: { ...data, ideas }, errors, warnings: [] };
}

/**
 * Проверенные сведения о нише (собраны вживую 28.09.2026: подписчики и просмотры
 * со страниц каналов, цитаты хуков из автосубтитров).
 *
 * Держим это в подсказке, потому что без проверенных цифр модель придумывает
 * «примеры» — а вся сила этого жанра в конкретике, которую можно проверить.
 */
const NICHE_RESEARCH = `Проверенные каналы ниши (подписчики и просмотры — на 28.09.2026):
Trust Me Bro — 1,4 млн (расследования сокрытий), Kelevin — 287 тыс. (мифы, оказавшиеся правдой; «Ancient Myths That Turned Out To Be True» — 2,6 млн),
The Paint Explainer — 2 млн (грубые «мышиные» рисунки; «The Most Guarded Places on Earth» — 2,1 млн),
easy, actually — 1,14 млн (саморазвитие с прямым обвинением; «quitting your youtube addiction is easy, actually» — 2,3 млн),
Sprouts — 1,94 млн (один эксперимент — один механизм; «How Power Corrupts»), Freedom in Thought — 1,72 млн, Kento Bento — 1,64 млн, Tapakapa — 265 тыс.

Что реально работает (по просмотрам за год): «то, во что ты верил, — ложь» (2,6 млн),
«место, куда нельзя» (2,1 млн), тело и смерть (1,7 млн), прямое обвинение зрителя в саморазвитии (до 3,9 млн).

Приёмы хука, снятые с реальных субтитров: заголовок как приговор и сразу кейс с датой и названием
(Ford Pinto, осень 1970); цитата-аксиома и вопрос о механизме; обвинительное переформулирование
в первой же фразе; холодное описание места, которого «не должно быть». Никаких «привет, ребята».

Злодея вводят через один конкретный объект (компания, эксперимент, место), а не через слово «система».

Свободное место в нише: ни один проверенный канал не соединяет рукотворных человечков,
холодный тон «тобой управляли» про бытовое (еда, тело, деньги) и разоблачение системы.
И у всех финал — призыв подписаться; разворота на собственную жизнь зрителя нет ни у кого.`;

/** 2. Ниша и выбор идеи: проект фиксирует одну идею, с которой работаем. */
export async function stageNiche({ idea, analysis, env }) {
  const data = await askJson({
    env,
    system: SYSTEM_WRITER,
    user: `${NICHE_RESEARCH}

Ниша канала: ${analysis?.niche ?? "видео-эссе со спрятанным механизмом"}.
Идея видео: ${idea.title}
Хук: ${idea.hook}
Суть: ${idea.essence}

Опиши замысел точно, чтобы по нему потом писать сценарий. Верни JSON:
{
  "title": "заголовок видео",
  "promise": "что зритель узнает, одна фраза",
  "mechanism": "тот самый спрятанный механизм, 2–3 предложения",
  "villain": "кто или что на этом зарабатывает",
  "finalTurn": "чем заканчивается: мысль, переворачивающая взгляд зрителя",
  "facts": ["3–5 конкретных фактов, чисел или имён, на которых держится доверие"]
}`,
  });
  const errors = [];
  if (!data.mechanism) errors.push("не описан спрятанный механизм");
  if (!data.finalTurn) errors.push("не придуман финальный поворот");
  return { output: data, errors, warnings: [] };
}

/** 3. Паспорт стиля: то, что потом обязано совпадать в каждом промте. */
export async function stageStyle({ referenceNotes, env, language = "ru" }) {
  const data = await askJson({
    env,
    system: `Ты арт-директор канала. Стиль не выдумывается: он описывается по референсам и потом
фиксируется дословно. Отвечай только JSON.`,
    user: `Референсные заметки о визуале ниши (кадры, описание техники, палитры):
"""
${referenceNotes}
"""

Верни JSON:
{
  "passport": {
    "medium": "техника и медиум", "line": "характер линии", "palette": ["конкретный цвет словами"],
    "characters": "как нарисованы люди", "backgrounds": "как нарисованы фоны",
    "lettering": "шрифт или леттеринг", "composition": "композиция и количество объектов",
    "mood": "настроение"
  },
  "styleBlock": "ОДНА английская строка — блок стиля, который дословно пойдёт в конец каждого промта картинки",
  "characterSheet": [
    { "name": "имя по-русски", "en": "постоянное английское описание этого героя, дословно для всех кадров" }
  ],
  "palette": ["#RRGGBB"]
}`,
  });
  const errors = [];
  if (!data.styleBlock || String(data.styleBlock).length < 40) {
    errors.push("блок стиля пуст или слишком короткий");
  }
  if (!Array.isArray(data.characterSheet) || data.characterSheet.length === 0) {
    errors.push("лист персонажей пуст");
  }
  return { output: data, errors, warnings: [] };
}

/** 4. Параметры: длина и язык. Здесь модель не нужна. */
export async function stageParams({ minutes, language = "ru" }) {
  const plan = planFor({ minutes, script: "" });
  return {
    output: {
      minutes,
      language,
      wordsTarget: plan.wordsTarget,
      shotsTarget: plan.shotsTarget,
      animationTarget: plan.animationTarget,
      voice: language === "ru" ? "ru-RU-DmitryNeural" : "en-US-GuyNeural",
    },
    errors: [],
    warnings: [],
  };
}

/**
 * 5. Сценарий-раскадровка.
 * Единственная стадия с петлёй починки: длинное видео почти никогда не выходит с
 * первого раза, и принимать «почти по правилам» дороже, чем один раз поправить.
 */
export async function stageScript({ concept, params, style, env, maxFixes = 2 }) {
  const { minutes, wordsTarget, shotsTarget, animationTarget } = params;
  const [wMin, wMax] = wordsTarget;
  const [sMin, sMax] = shotsTarget;

  const task = `Напиши полный сценарий-раскадровку видео длительностью ${minutes} минут.

Замысел: ${concept.title}
Обещание зрителю: ${concept.promise}
Спрятанный механизм: ${concept.mechanism}
На ком зарабатывают: ${concept.villain}
Финальный поворот: ${concept.finalTurn}
Факты для доверия: ${(concept.facts ?? []).join("; ")}

Жёсткие требования:
- всего слов в озвучке: от ${wMin} до ${wMax} (это и есть ${minutes} минут речи, темп 150–190 слов в минуту);
- кадров: от ${sMin} до ${sMax}; один кадр — одна фраза, 8–18 слов;
- помеченных анимацией кадров: примерно ${animationTarget[0]}–${animationTarget[1]} (не больше четверти);
  анимация только там, где движение действительно нужно: действие, появление, реакция;
- первый кадр — холодный заход с конкретной деталью, без объяснения, о чём видео;
- последний кадр — мысль, переворачивающая взгляд зрителя на собственную жизнь;
- никаких списков, никаких «в этом видео мы разберём»;
- ЯЗЫК ОЗВУЧКИ: ${params.language === "en" ? "английский. Поля narration и onScreen пиши по-английски (остальные поля — как обычно), темп 150–170 слов в минуту" : "русский"}.

Верни JSON:
{
  "shots": [
    { "n": 1, "narration": "ровно то, что произносит голос за кадром",
      "onScreen": "что видно в кадре, коротко и конкретно",
      "animated": false,
      "scene": "подсказка художнику: главные предметы кадра" }
  ]
}`;

  let answer = await askJson({ env, system: SYSTEM_WRITER, user: task, temperature: 0.9 });
  let shots = normalizeShots(answer.shots);
  let check = checkStage("script", { minutes, shots, language: params.language });
  const history = [];

  for (let attempt = 1; attempt <= maxFixes && check.errors.length; attempt += 1) {
    history.push({ attempt, errors: check.errors.slice(0, 6) });
    const fixRequest = `${task}

Ты уже дал ответ. Проверка нашла нарушения, которые надо устранить, не потеряв ни одного кадра:
${check.errors.map((e) => `- ${e}`).join("\n")}

Вот твой прежний сценарий, исправь его и верни целиком в том же JSON:
${JSON.stringify({ shots }, null, 0).slice(0, 24000)}`;

    answer = await askJson({ env, system: SYSTEM_WRITER, user: fixRequest, temperature: 0.7 });
    shots = normalizeShots(answer.shots);
    check = checkStage("script", { minutes, shots, language: params.language });
  }

  return { output: { shots, stats: check.stats, fixes: history }, errors: check.errors, warnings: check.warnings };
}

/** Приводит кадры к строгой форме: модель любит то строку вместо true, то строку в номере. */
export function normalizeShots(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((shot, i) => ({
    n: Number.isFinite(Number(shot?.n)) ? Number(shot.n) : i + 1,
    narration: String(shot?.narration ?? "").trim(),
    onScreen: String(shot?.onScreen ?? shot?.scene ?? "").trim(),
    animated: shot?.animated === true || shot?.animated === "true" || shot?.animated === "да",
    scene: shot?.scene ? String(shot.scene).trim() : undefined,
  }));
}

/**
 * 6. Промты к картинкам. Блок стиля приклеивается кодом, а не моделью: она его
 * «улучшает» и перестаёт совпадать, а совпадение обязательно.
 */
export async function stageImagePrompts({ shots, style, env, batch = 20, styleBlockSuffix }) {
  const suffix = styleBlockSuffix ?? "16:9 horizontal composition, centered subject, plenty of white negative space";
  const all = [];

  for (let i = 0; i < shots.length; i += batch) {
    const slice = shots.slice(i, i + batch);
    const data = await askJson({
      env,
      system: `Ты пишешь промты для генератора изображений. Только английский язык, естественные
фразы, без веса и без синтаксиса конкретного сервиса. Отвечай только JSON.`,
      user: `Кадры видео. Для каждого напиши английский промт: сначала что и где происходит,
потом постоянные описания героев из листа персонажей — теми же словами.

Лист персонажей:
${JSON.stringify(style.characterSheet ?? [], null, 1)}

Кадры:
${JSON.stringify(slice.map((s) => ({ n: s.n, onScreen: s.onScreen, scene: s.scene })), null, 1)}

Верни JSON: { "prompts": [ { "shot": номер, "text": "английский промт" } ] }
Не добавляй сам блок стиля — его допишут отдельно. Не добавляй соотношение сторон.`,
      temperature: 0.7,
    });

    for (const p of data.prompts ?? []) {
      const shot = Number(p.shot);
      if (!Number.isFinite(shot)) continue;
      all.push({ shot, text: `${String(p.text).trim()} ${style.styleBlock} ${suffix}`.trim() });
    }
  }

  const sorted = all.sort((a, b) => a.shot - b.shot);
  const check = checkStage("image_prompts", { shots, prompts: sorted, styleBlock: style.styleBlock });
  return { output: { prompts: sorted }, errors: check.errors, warnings: check.warnings };
}

/** 7. Промты к анимациям: только на помеченные кадры. */
export async function stageVideoPrompts({ shots, style, imagePrompts, env, batch = 12 }) {
  const animated = shots.filter((s) => s.animated);
  const all = [];

  for (let i = 0; i < animated.length; i += batch) {
    const slice = animated.slice(i, i + batch);
    const data = await askJson({
      env,
      system: `Ты пишешь промты для оживления нарисованных кадров. Только английский. Отвечай JSON.`,
      user: `Это кадры, которые чуть оживут. Для каждого опиши ОДНО маленькое движение и запрети всё
остальное. Камера стоит. Стиль и рисунок не меняются.

Кадры:
${JSON.stringify(slice.map((s) => ({ n: s.n, onScreen: s.onScreen })), null, 1)}

Верни JSON: { "prompts": [ { "shot": номер, "motion": "что именно чуть двигается, по-английски" } ] }`,
      temperature: 0.6,
    });

    const byShot = new Map((data.prompts ?? []).map((p) => [Number(p.shot), p.motion]));
    for (const shot of slice) {
      const motion = String(byShot.get(shot.n) ?? "a single arm reaches slowly toward the object").trim();
      const base = imagePrompts.find((p) => p.shot === shot.n)?.text ?? "";
      all.push({
        shot: shot.n,
        text:
          `Animate this flat 2D hand-drawn cartoon, perfectly preserving the original art style, line work, ` +
          `colors and composition. Subtle limited motion only: ${motion}. Camera locked, no zoom, no pan. ` +
          `No new objects, no style change, no morphing, no 3D, no realism, no added text or sound. ` +
          `Smooth looping 2D motion, ~5 seconds. Reference frame: ${base.slice(0, 400)}`,
      });
    }
  }

  const sorted = all.sort((a, b) => a.shot - b.shot);
  const check = checkStage("video_prompts", { shots, prompts: sorted, styleBlock: style.styleBlock });
  return { output: { prompts: sorted }, errors: check.errors, warnings: check.warnings };
}

export const STAGE_FUNCTIONS = {
  transcript: stageTranscript,
  niche: stageNiche,
  style: stageStyle,
  params: stageParams,
  script: stageScript,
  image_prompts: stageImagePrompts,
  video_prompts: stageVideoPrompts,
};
