/**
 * Правка одного кадра моделью.
 *
 * Студия показывает 225 кадров, но поправить в них одну реплику нельзя: остаётся
 * гнать стадию сценария целиком — это сорок минут и квота модели. Здесь живёт
 * самая тонкая часть такой правки: что спросить у модели и как её ответ принять.
 * Всё остальное (HTTP, диск) — в server.js, потому что правила должны проверяться
 * без сервера.
 *
 * Три правила взяты из дорогих уроков конвейера:
 *   - правило языка стоит в задаче явно (английский сценарий, переписанный
 *     по-русски, не озвучивается вовсе);
 *   - правка касается одного кадра и больше ничего;
 *   - плохой ответ модели не должен стоить кадра — лучше оставить как было.
 */

/** Поля кадра, которые можно править, и их пределы. */
export const EDITABLE = {
  narration: { max: 320, label: "реплика" },
  onScreen: { max: 48, label: "надпись в кадре" },
};

/** Стадии, которые после правки кадра придётся прогнать заново. */
export const DEPENDENT_STAGES = ["image_prompts", "video_prompts", "voice", "assemble"];

/** Грубо: латиница или кириллица. Этого хватает, чтобы не сменить язык кадра. */
export function scriptOf(text = "") {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cyrillic = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  if (!latin && !cyrillic) return "unknown";
  return latin > cyrillic ? "latin" : "cyrillic";
}

/**
 * Задача модели: переписать один кадр, не тронув остальные.
 *
 * Язык берём из самой реплики, а не из кода проекта: у проекта язык может быть
 * указан неверно (или кадр написан на другом), и тогда правка переведёт фильм.
 */
export function rewriteTask(shot, { instruction, style = "", field = "narration" } = {}) {
  const rule = EDITABLE[field];
  if (!rule) throw new Error(`поле ${field} не правится`);

  const current = String(shot[field] ?? "");
  const language = scriptOf(shot.narration || current);
  const languageRule =
    language === "latin"
      ? "Пиши по-английски: кадр остаётся англоязычным."
      : language === "cyrillic"
        ? "Пиши по-русски: кадр остаётся русскоязычным."
        : "Пиши на том же языке, что и сейчас.";

  return {
    system: `Ты редактор сценария видео. Тебе дают один кадр: реплику диктора и надпись в кадре.
Переписываешь только то, о чём просят, и отвечаешь JSON вида {"narration": "...", "onScreen": "..."}.
Других кадров нет — придумывать продолжение или нумерацию нельзя.
${languageRule}
${style ? `Стиль канала, которого надо держаться:\n${style}` : ""}
Надпись в кадре — короткая (до ${EDITABLE.onScreen.max} знаков), без точки в конце.`,
    user: `Кадр ${shot.n} сейчас:
реплика: ${current || "(пусто)"}
надпись в кадре: ${shot.onScreen || "(пусто)"}

Что сделать: ${instruction || "перепиши реплику короче и конкретнее, смысл сохрани"}
Правь поле «${rule.label}»${field === "onScreen" ? "" : " и, если нужно, надпись под неё"}.
Верни JSON с обоими полями.`,
    temperature: 0.7,
  };
}

/**
 * Принять ответ модели.
 *
 * Возвращает `{shot, changed, rejected}` — новый кадр и честный рассказ о том,
 * что не приняли. Пустой, слишком длинный или чужой по языку ответ отбрасывается:
 * кадр дороже, чем ответ модели.
 */
export function applyRewrite(shot, answer, { field = "narration" } = {}) {
  const rule = EDITABLE[field];
  if (!rule) throw new Error(`поле ${field} не правится`);
  const rejected = [];
  const next = { ...shot };

  const wanted = typeof answer?.[field] === "string" ? answer[field].trim() : "";
  if (!wanted) {
    rejected.push(`${rule.label}: модель не вернула текст`);
  } else if (wanted.length > rule.max) {
    rejected.push(`${rule.label}: ${wanted.length} знаков при пределе ${rule.max}`);
  } else if (scriptOf(wanted) !== scriptOf(shot[field]) && scriptOf(shot[field]) !== "unknown") {
    /* Смена алфавита означает смену языка фильма — это не правка, а перевод. */
    rejected.push(`${rule.label}: ответ на другом языке`);
  } else {
    next[field] = wanted;
  }

  const caption = typeof answer?.onScreen === "string" ? answer.onScreen.trim() : "";
  /* Язык надписи сверяем с репликой, а не с самой надписью: кадр задаёт язык
     фильма, и подпись на чужом языке в нём — та же подмена, что в реплике. */
  const anchor = scriptOf(shot.narration || shot[field]);
  if (!caption) {
    /* Пустая надпись — не правка: оставляем как было. */
  } else if (caption.length > EDITABLE.onScreen.max) {
    rejected.push(`надпись в кадре: ${caption.length} знаков при пределе ${EDITABLE.onScreen.max}`);
  } else if (anchor !== "unknown" && scriptOf(caption) !== anchor) {
    rejected.push("надпись в кадре: ответ на другом языке");
  } else {
    next.onScreen = caption;
  }

  /* Номер кадра — не предмет правки: по нему лежат клипы и картинки. */
  next.n = shot.n;
  next.animated = shot.animated;

  const changed = next[field] !== shot[field] || next.onScreen !== shot.onScreen;
  return { shot: next, changed, rejected };
}

/** Меняет ли правка озвучку: тогда стадии после сценария устареют. */
export function staleStages(changed) {
  return changed ? DEPENDENT_STAGES : [];
}
