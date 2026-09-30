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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkStage, countWords, languageOf, planFor } from "../validate.js";

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

/**
 * Идеи по теме: модель придумывает сама, а не получает готовую.
 *
 * Раньше идею задавал человек, и конвейер умел только исполнять. Теперь на входе
 * может быть просто тема — «что делали древние люди ночью» — а идеи, механизм и
 * виноватого ищет модель, опираясь на проверенные сведения о нише ниже.
 */
export async function stageIdeas({ topic, env, count = 8 }) {
  const data = await askJson({
    env,
    system: SYSTEM_WRITER,
    user: `${NICHE_RESEARCH}

Тема: ${topic}

Придумай ${count} идей для видео по этой теме. Каждая идея — это свой спрятанный
механизм, а не пересказ темы: у каждой должен быть виноватый или система, на которой
кто-то выиграл, и поворот в конце, переворачивающий взгляд зрителя на его жизнь.

Требования к идеям:
- заголовок — как приговор или как обещание раскрытия, без вопросов и без «вы не поверите»;
- хук — первая фраза видео: конкретная деталь с числом, годом или именем;
- механизм — 2–3 предложения о том, что на самом деле происходит;
- виноватый — кто или что на этом выигрывает;
- поворот — чем видео заканчивается: мысль про жизнь зрителя, а не призыв подписаться;
- факты — 3–5 фактов, на которых держится доверие, и КАЖДЫЙ должен быть настоящим:
  назови исследование, находку, место или имя учёного и год. Если по теме нет
  надёжных свидетельств — возьми другую грань темы, а не сочиняй механизм: выдуманная
  антропология разрушает доверие быстрее, чем слабая идея;
- ни одна идея не повторяет другую и не повторяет перечисленные выше каналы.

Верни JSON:
{ "ideas": [ { "title": "", "hook": "", "mechanism": "", "villain": "", "finalTurn": "", "facts": [""] } ] }`,
    temperature: 1.0,
  });

  const ideas = Array.isArray(data.ideas) ? data.ideas : [];
  const errors = [];
  if (ideas.length < Math.min(4, count)) errors.push(`идей мало: ${ideas.length}`);
  for (const [index, idea] of ideas.entries()) {
    if (!idea?.mechanism) errors.push(`идея ${index + 1}: не описан механизм`);
    if (!idea?.finalTurn) errors.push(`идея ${index + 1}: нет поворота в конце`);

    // Факт без имени, места или года — это не факт, а общее место. Проверяем не
    // ради формальности: такие «факты» и есть то, за что зритель перестаёт верить.
    const facts = Array.isArray(idea?.facts) ? idea.facts : [];
    if (facts.length < 3) {
      errors.push(`идея ${index + 1}: фактов меньше трёх`);
    } else if (!facts.every((fact) => /[0-9]|\b[A-Z][a-z]{2,}/.test(String(fact)))) {
      errors.push(`идея ${index + 1}: в фактах нет ни года, ни места, ни имени — доверия не будет`);
    }
  }
  return { output: { topic, ideas }, errors, warnings: [] };
}

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
${idea.mechanism ? `Уже найденный механизм: ${idea.mechanism}` : ""}
${idea.villain ? `Кто на этом выигрывает: ${idea.villain}` : ""}
${idea.finalTurn ? `Задуманный поворот в конце: ${idea.finalTurn}` : ""}
${idea.facts?.length ? `Факты, которые надо сохранить: ${idea.facts.join("; ")}` : ""}

Сохрани всё, что уже найдено выше, и дополни недостающее — не выдумывай другое.

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
 * Сколько кадров заказываем у модели за один раз.
 *
 * Видео на пятнадцать минут — это около двухсот пятидесяти кадров. Одной выдачей
 * такой сценарий не пишется: модель теряет середину и повторяется, а ответ не
 * помещается в разумный предел. Поэтому длинный сценарий собирается блоками, но
 * собирается как одно целое — блок знает свой участок и что было до него.
 */
const BLOCK_SHOTS = 20;

/** Роль участка в общей драматургии: без этого блоки повторяют друг друга. */
function actFor(index, total) {
  if (index === 0) {
    return "ЗАХОД: холодный вход с конкретной деталью — число, год, имя; сразу кейс. Вопросов зрителю не задавать.";
  }
  if (index === total - 1) {
    return "ФИНАЛ: разворот на собственную жизнь зрителя. Никаких призывов подписаться, лайкать или «досмотреть до конца».";
  }
  const share = index / Math.max(1, total - 1);
  if (share < 0.4) return "РАСКРЫТИЕ: следующий слой механизма, конкретика для доверия — имена, годы, суммы, названия исследований.";
  if (share < 0.75) return "ВИНОВАТЫЙ: кто на этом выигрывает и как устроена система; одна кинематографичная сцена-эпизод.";
  return "СГУЩЕНИЕ: каждый следующий слой хуже предыдущего, подводка к финальному развороту.";
}

/**
 * 5. Сценарий-раскадровка.
 * Единственная стадия с петлёй починки: длинное видео почти никогда не выходит с
 * первого раза, и принимать «почти по правилам» дороже, чем один раз поправить.
 */
export async function stageScript({ concept, params, style, env, maxFixes = 2, projectDir = null }) {
  const { minutes, wordsTarget, shotsTarget, animationTarget } = params;
  const requestedLanguage = params.language ?? "ru";
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

  // Длинный сценарий — блоками. Короткий пишется целиком, как раньше.
  const blockCount = Math.ceil(sMin / BLOCK_SHOTS);
  const history = [];
  let shots = [];
  // Объявлено здесь, а не в ветке: на длинном видео ветка «один заход» не выполняется,
  // а цикл исправлений ниже всё равно обращается к ответу модели (был ReferenceError).
  let answer;

  if (blockCount > 1) {
    const perBlockShots = Math.round(sMin / blockCount);
    const perBlockWords = Math.round(wMin / blockCount);

    for (let index = 0; index < blockCount; index += 1) {
      const from = index * perBlockShots + 1;
      const to = index === blockCount - 1 ? sMin : (index + 1) * perBlockShots;
      const tail = shots.slice(-4).map((s) => `  ${s.n}. ${s.narration}`).join("\n");
      const head = shots[0]?.narration ?? "";

      const blockTask = `Пиши участок сценария-раскадровки. Это ${index + 1}-й участок из ${blockCount}
видео длительностью ${minutes} минут, и он должен продолжать уже написанное, а не начинать заново.

Что уже известно про весь фильм:
Замысел: ${concept.title}
Обещание зрителю: ${concept.promise}
Спрятанный механизм: ${concept.mechanism}
На ком зарабатывают: ${concept.villain}
Финальный поворот, к которому всё идёт: ${concept.finalTurn}
Факты для доверия: ${(concept.facts ?? []).join("; ")}
${head ? `Первая фраза фильма: «${head}»` : ""}

Твой участок — ${actFor(index, blockCount)}.

Последние кадры предыдущего участка (продолжай с этой мысли, не повторяй её):
${tail || "  (это начало фильма)"}

Жёсткие требования к участку:
- кадров ровно от ${to - from + 1 - 3} до ${to - from + 1 + 3}, номера начни с ${from};
- слов в озвучке участка: около ${perBlockWords} (плюс-минус четверть);
- один кадр — одна фраза, 8–18 слов;
- ${Math.max(1, Math.round((animationTarget[0] / blockCount)))}–${Math.max(2, Math.round((animationTarget[1] / blockCount)))} кадров с флагом animated, и только там, где движение нужно;
- никаких «в этом видео мы разберём», никаких списков, никаких вопросов зрителю;
- каждое утверждение — с конкретикой: имя, год, число, название.

Верни JSON:
{
  "shots": [
    { "n": ${from}, "narration": "ровно то, что произносит голос за кадром",
      "onScreen": "что видно в кадре, коротко и конкретно",
      "animated": false,
      "scene": "подсказка художнику: главные предметы кадра" }
  ]
}`;

      // Готовый участок сразу ложится на диск и берётся оттуда при повторе.
      // Длинный сценарий пишется сорок минут, и обрыв на последнем участке не
      // должен отправлять в корзину всю работу — она уже оплачена ожиданием.
      const blockPath = projectDir ? join(projectDir, "script-blocks", `block-${String(index + 1).padStart(2, "0")}.json`) : null;
      if (blockPath && !env.KADR_FORCE && existsSync(blockPath)) {
        const saved = JSON.parse(readFileSync(blockPath, "utf8"));
        const restored = normalizeShots(saved.shots).map((shot, i) => ({ ...shot, n: from + i }));
        // Участок с диска берётся только если он написан на нужном языке. Иначе
        // получается тихая поломка: проект просит английский ролик, с диска
        // приходит русский текст, английский голос его не озвучивает, и стадия
        // озвучки падает через полтора часа после начала прогона.
        const wrongLanguage =
          restored.length > 0 && languageOf(restored.map((s) => s.narration).join(" ")) !== languageOf(requestedLanguage);
        if (restored.length && !wrongLanguage) {
          shots.push(...restored);
          history.push({ block: index + 1, shots: restored.length, words: saved.words ?? 0, act: actFor(index, blockCount).split(":")[0], fromDisk: true });
          console.log(`  участок ${index + 1}/${blockCount}: взят готовый с диска (кадров ${restored.length})`);
          continue;
        }
        if (wrongLanguage) {
          console.log(
            `  участок ${index + 1}/${blockCount}: на диске текст другого языка (нужен «${requestedLanguage}») — пишу заново`,
          );
        }
      }

      // Пауза перед участком: у бесплатного тарифа минутный предел, и без
      // передышки следующий участок упирается в него же.
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 6000));

      // Модель часто отдаёт меньше кадров, чем просили: она «закругляет» участок.
      // Поэтому добираем остаток отдельными просьбами, пока не наберём нужное —
      // иначе длинное видео незаметно превращается в короткое.
      const wanted = to - from + 1;
      let part = [];
      for (let round = 1; round <= 4; round += 1) {
        const need = wanted - part.length;
        if (need <= 0) break;

        const tailNow = part.length ? part.slice(-3).map((x) => `  ${x.narration}`).join("\n") : tail;
        const roundTask = part.length
          ? `${blockTask}

Участок уже начат, вот последние написанные кадры:
${tailNow}

Допиши ровно ещё ${need} кадров — продолжай с этой мысли, не повторяй её. Номера с ${from + part.length}.`
          : blockTask;

        const answer = await askJson({ env, system: SYSTEM_WRITER, user: roundTask, temperature: 0.9 });
        const got = normalizeShots(answer.shots);
        if (!got.length) break;
        part.push(...got);
        if (round < 4 && part.length >= wanted) break;
        if (part.length < wanted) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      part = part.slice(0, wanted).map((shot, i) => ({ ...shot, n: from + i }));
      const blockWords = part.reduce((sum, shot) => sum + countWords(shot.narration), 0);

      if (blockPath && part.length) {
        mkdirSync(dirname(blockPath), { recursive: true });
        writeFileSync(blockPath, JSON.stringify({ block: index + 1, words: blockWords, act: actFor(index, blockCount).split(":")[0], shots: part }, null, 1), "utf8");
      }
      history.push({ block: index + 1, shots: part.length, words: blockWords, act: actFor(index, blockCount).split(":")[0] });
      console.log(
        `  участок ${index + 1}/${blockCount}: кадров ${part.length}, слов ${blockWords} (${actFor(index, blockCount).split(":")[0].toLowerCase()})`,
      );
      shots.push(...part);
    }

    // Нумерация после склейки: модель на стыках сбивается, а порядок обязателен.
    shots = shots.map((shot, i) => ({ ...shot, n: i + 1 }));
  } else {
    answer = await askJson({ env, system: SYSTEM_WRITER, user: task, temperature: 0.9 });
    shots = normalizeShots(answer.shots);
  }

  let check = checkStage("script", { minutes, shots, language: params.language });

  for (let attempt = 1; attempt <= maxFixes && check.errors.length; attempt += 1) {
    // Иначе лог после участков выглядит мёртвым, и непонятно, идёт работа или прогон встал.
    console.log(`  проверка сценария: замечаний ${check.errors.length}, исправление ${attempt}/${maxFixes}`);
    history.push({ attempt, errors: check.errors.slice(0, 6) });
    const fixRequest = `${task}

Ты уже дал ответ. Проверка нашла нарушения, которые надо устранить, не потеряв ни одного кадра:
${check.errors.map((e) => `- ${e}`).join("\n")}

Вот твой прежний сценарий, исправь его и верни целиком в том же JSON:
${JSON.stringify({ shots }, null, 0).slice(0, 24000)}`;

    answer = await askJson({ env, system: SYSTEM_WRITER, user: fixRequest, temperature: 0.7 });
    const repaired = normalizeShots(answer.shots);
    // Ответ «исправь весь сценарий» почти всегда приходит урезанным (16000 токенов на 225
    // кадров не хватает), а salvage спасает начало. Если принять его как есть, готовый
    // сценарий на 225 кадров молча заменяется огрызком на 4 кадра — и прогон уходит
    // не к видео, а к пустому сценарию. Поэтому укорачивать сценарий запрещено.
    if (repaired.length >= shots.length) {
      shots = repaired.map((shot, i) => ({ ...shot, n: i + 1 }));
    } else {
      console.log(
        `  исправление отброшено: ответ короче сценария (${repaired.length} кадров против ${shots.length}) — прежний сценарий сохранён`,
      );
    }
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
export async function stageImagePrompts({ shots, style, env, batch = 20, styleBlockSuffix, projectDir = null }) {
  const suffix =
    styleBlockSuffix ??
    "16:9 horizontal composition, subject centered, clear foreground and background separation";
  const all = [];

  // Участки независимы: у каждого свой кусок кадров, свой файл на диске и свой номер в
  // итоговом списке (он всё равно сортируется по номеру кадра). Один участок занимает
  // около восьми минут — три ждут сеть, — и последовательный обход девятнадцати участков
  // растягивает стадию на часы, хотя предел здесь не процессор, а ожидание ответа.
  const parts = [];
  for (let i = 0; i < shots.length; i += batch) parts.push(shots.slice(i, i + batch));
  const partCount = parts.length;
  const PARTS_AT_ONCE = Math.max(1, Math.min(Number(process.env.KADR_PROMPT_PARTS ?? 3), partCount));

  let nextPart = 0;
  const runPart = async () => {
    for (;;) {
      const index = nextPart++;
      if (index >= partCount) return;
      const slice = parts[index];
      const partNumber = index + 1;
      const t0 = Date.now();
      const partPath = projectDir
        ? join(projectDir, "image-prompt-parts", `part-${String(partNumber).padStart(2, "0")}.json`)
        : null;
      let data = null;
      if (partPath && existsSync(partPath)) {
        try {
          data = JSON.parse(readFileSync(partPath, "utf8"));
          console.log(`  промты ${partNumber}/${partCount}: взят готовый с диска (${data.prompts?.length ?? 0} шт)`);
        } catch {
          data = null;
        }
      }
      if (!data) {
        console.log(`  промты ${partNumber}/${partCount}: кадры ${slice[0].n}–${slice[slice.length - 1].n}`);
        data = await askJson({
      env,
      system: `Ты пишешь промты для генератора изображений. Только английский язык, естественные
фразы, без веса и без синтаксиса конкретного сервиса. Отвечай только JSON.`,
      user: `Кадры фильма. Для каждого напиши ПОДРОБНЫЙ английский промт — связный абзац из
4–7 предложений, а не одну фразу. Что должно быть в промте:

1. план и камера: wide establishing shot / medium shot / close-up; с какой точки видно сцену;
2. место целиком: что за здание или улица, время дня, погода, из чего сделаны стены и крыши;
3. передний план и задний план: что стоит ближе к зрителю, что видно вдали;
4. герой: его постоянное описание из листа персонажей — ТЕМИ ЖЕ словами — и чем он занят
   именно в этом кадре, что у него на лице;
5. цвета: конкретные цвета заливок для главных предметов кадра;
6. надписи и указатели — это язык канала, а не украшение:
   • если в кадре есть предмет, на который стоит показать пальцем, опиши КРАСНУЮ СТРЕЛКУ,
     указывающую на него, и рядом жирную чёрную надпись большими буквами — дословно в кавычках
     (например a bold black caption reading "CULTURE");
   • если кадр опирается на факт с датой или числом, добавь плашку с датой в углу кадра
     (например a small black date stamp reading "Nov 2021" in the top-left corner);
   • вывески и названия мест — дословно в кавычках (a sign reading "SOUND 80");
7. настроение кадра одним словом.

Никаких списков и сокращений. Названия сервисов, вес слов и синтаксис одного генератора
не упоминай.

Лист персонажей:
${JSON.stringify(style.characterSheet ?? [], null, 1)}

Кадры:
${JSON.stringify(slice.map((s) => ({ n: s.n, onScreen: s.onScreen, scene: s.scene })), null, 1)}

Верни JSON: { "prompts": [ { "shot": номер, "text": "подробный английский промт абзацем" } ] }
Не добавляй сам блок стиля — его допишут отдельно. Не добавляй соотношение сторон.
Длина одного промта: не меньше 45 слов.`,
      temperature: 0.7,
      });

      if (partPath && Array.isArray(data?.prompts) && data.prompts.length) {
        mkdirSync(dirname(partPath), { recursive: true });
        writeFileSync(partPath, JSON.stringify(data), "utf8");
      }
      console.log(
        `  промты ${partNumber}/${partCount}: получено ${data?.prompts?.length ?? 0} шт за ${Math.round((Date.now() - t0) / 1000)} с`,
      );
    }

    for (const p of data.prompts ?? []) {
      const shot = Number(p.shot);
      if (!Number.isFinite(shot)) continue;
      all.push({ shot, text: `${String(p.text).trim()} ${style.styleBlock} ${suffix}`.trim() });
    }
    }
  };

  await Promise.all(Array.from({ length: PARTS_AT_ONCE }, runPart));

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
  ideas: stageIdeas,
  niche: stageNiche,
  style: stageStyle,
  params: stageParams,
  script: stageScript,
  image_prompts: stageImagePrompts,
  video_prompts: stageVideoPrompts,
};
