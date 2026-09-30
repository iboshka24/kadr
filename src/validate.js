/**
 * Проверки конвейера.
 *
 * Это главная часть продукта, а не приложение к нему. Промпт задаёт правила
 * словами («примерно каждый пятый кадр — анимация», «блок стиля дословно в
 * каждом промте»), но на видео в 8 минут это 120 с лишним кадров и столько же
 * промтов — глазами такое не проверяется, а нейросеть нарушает правила тихо.
 * Поэтому каждый слоган промпта превращён здесь в число и падает тестом.
 */

export const DEFAULTS = {
  /** Темп озвучки: замерено по эталону ниши, слов в минуту. */
  wordsPerMinute: [150, 190],
  /** Новый кадр каждые 3–4 секунды. */
  shotsPerMinute: [15, 18],
  /** Анимация — примерно каждый пятый кадр, и только там, где она осмысленна. */
  animationShare: [0.15, 0.25],
  /** Длина кадра в секундах. */
  shotSeconds: [3, 4],
};

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function countWords(text) {
  return String(text ?? "")
    .replace(/[\u2014\u2013]/g, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Язык текста по письменности: кириллица или латиница.
 *
 * Нужен, чтобы поймать тихую поломку: проект просит английский ролик, а с диска
 * берётся русский сценарий из прошлого прогона, английский голос его не
 * озвучивает, и стадия озвучки падает с `NoAudioReceived` через полтора часа.
 * Пустая строка считается «неизвестно» — тогда текст принимается как есть.
 */
export function languageOf(text) {
  const sample = String(text ?? "").slice(0, 4000);
  const cyrillic = (sample.match(/[\u0400-\u04FF]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cyrillic + latin < 10) return "unknown";
  return cyrillic > latin ? "ru" : "en";
}

/**
 * План видео: сколько слов, кадров, анимаций должно получиться.
 * Из него же считаются допуски, чтобы проверка знала, с чем сравнивать.
 */
export function planFor({ minutes, script, shots: shotCount }) {
  const [wMin, wMax] = DEFAULTS.wordsPerMinute;
  const [sMin, sMax] = DEFAULTS.shotsPerMinute;
  const words = countWords(script);
  // Кадры считаем по массиву, если он передан, иначе по явному числу: строку
  // сценария сюда тоже передают, и принимать её за ноль кадров — это ложная
  // тревога в отчёте проверки.
  const shots = Array.isArray(script)
    ? script.length
    : Number.isFinite(shotCount)
      ? shotCount
      : 0;
  return {
    minutes,
    words,
    shots,
    wordsTarget: [Math.round(minutes * wMin), Math.round(minutes * wMax)],
    shotsTarget: [Math.round(minutes * sMin), Math.round(minutes * sMax)],
    animationTarget: [
      Math.floor(minutes * sMin * DEFAULTS.animationShare[0]),
      Math.ceil(minutes * sMax * DEFAULTS.animationShare[1]),
    ],
    wordsPerMinute: minutes > 0 ? round(words / minutes) : 0,
    shotsPerMinute: minutes > 0 ? round(shots / minutes) : 0,
  };
}

/**
 * Проверка раскадровки.
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
export function validateScript({ minutes, shots, language = "ru" }) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(shots) || shots.length === 0) {
    return { errors: ["раскадровка пуста"], warnings, stats: planFor({ minutes, script: [] }) };
  }

  for (const shot of shots) {
    const n = shot.n ?? "?";
    if (!Number.isInteger(shot.n)) errors.push(`кадр ${n}: нет номера`);
    if (!shot.narration || !String(shot.narration).trim()) errors.push(`кадр ${n}: нет озвучки`);
    if (!shot.onScreen || !String(shot.onScreen).trim()) errors.push(`кадр ${n}: не сказано, что на экране`);
    if (typeof shot.animated !== "boolean") errors.push(`кадр ${n}: не решено, будет ли анимация`);
  }

  const numbers = shots.map((s) => s.n);
  const expected = shots.map((_, i) => i + 1);
  if (numbers.join(",") !== expected.join(",")) {
    errors.push(`номера кадров идут не подряд: ${numbers.slice(0, 8).join(",")}…`);
  }

  const script = shots.map((s) => s.narration).join(" ");
  const stats = planFor({ minutes, script, shots: shots.length });

  if (stats.words < stats.wordsTarget[0] * 0.85) {
    errors.push(
      `слов мало: ${stats.words} при цели ${stats.wordsTarget[0]}–${stats.wordsTarget[1]} для ${minutes} мин`,
    );
  }
  if (stats.words > stats.wordsTarget[1] * 1.15) {
    warnings.push(`слов много: ${stats.words}, озвучка выйдет длиннее ${minutes} мин`);
  }
  if (stats.shots < stats.shotsTarget[0] * 0.85) {
    errors.push(`кадров мало: ${stats.shots} при цели ${stats.shotsTarget[0]}–${stats.shotsTarget[1]}`);
  }
  if (stats.shots > stats.shotsTarget[1] * 1.15) {
    warnings.push(`кадров много: ${stats.shots}`);
  }

  const animated = shots.filter((s) => s.animated).length;
  const share = stats.shots > 0 ? animated / stats.shots : 0;
  if (share > DEFAULTS.animationShare[1]) {
    errors.push(
      `анимаций слишком много: ${animated} из ${stats.shots} (${round(share * 100)}%) — эталон сдержанный`,
    );
  }
  if (animated > 0 && share < DEFAULTS.animationShare[0] * 0.5) {
    warnings.push(`анимаций почти нет: ${animated} из ${stats.shots}`);
  }

  // Заход. Формула ниши (снята с реальных видео: Trust Me Bro начинает с «осенью
  // 1970 Ford выпустил Pinto») требует холодного входа с конкретной деталью —
  // датой, числом, именем. Вопрос к зрителю в первом кадре эту формулу ломает: он
  // просит зрителя поработать вместо того, чтобы сразу втянуть его фактом.
  const first = shots[0];
  if (first?.narration) {
    const opening = String(first.narration).trim();
    if (/[?？]\s*$/.test(opening)) {
      errors.push(
        "первый кадр начинается вопросом: формула ниши требует холодного захода с конкретной деталью, а не вопроса зрителю",
      );
    }
    // Конкретика: число, год или имя собственное (слово с заглавной не в начале).
    const body = opening.replace(/^[^\p{L}]*\p{L}/u, "");
    const hasNumber = /[0-9]/.test(opening);
    const hasName = /\s[\p{Lu}][\p{Ll}]{2,}/u.test(body);
    if (!hasNumber && !hasName) {
      warnings.push(
        "в первом кадре нет конкретики (числа, года или имени) — заход звучит общо",
      );
    }
  }

  // Финал — это то, чем канал отличается. У всех проверенных каналов ниши
  // (Trust Me Bro, easy actually, Tapakapa, Sprouts) последние слова — призыв
  // подписаться, и финал поэтому не запоминается. Наш финал заканчивается
  // разворотом на собственную жизнь зрителя, а не просьбой о подписке.
  const last = shots[shots.length - 1];
  const cta = /подпиш|подписывай|подпишись|лайк|колокольчик|subscrib|like and|patreon/i;
  if (last?.narration && cta.test(String(last.narration))) {
    errors.push(
      "финал — призыв к подписке: так заканчивают все каналы ниши, " +
        "а кадр должен переворачивать взгляд зрителя на его собственную жизнь",
    );
  }

  return { errors, warnings, stats: { ...stats, animated, animationShare: round(share) } };
}

/**
 * Проверка промтов к картинкам.
 *
 * Блок стиля обязан совпадать ПОСИМВОЛЬНО: одна переставленная запятая — и кадр
 * выпадает из канала. Именно эта проверка ловит «почти такой же» промт.
 */
export function validateImagePrompts({ shots, prompts, styleBlock }) {
  const errors = [];
  const warnings = [];
  const byShot = new Map(prompts.map((p) => [p.shot, p]));

  for (const shot of shots) {
    const prompt = byShot.get(shot.n);
    if (!prompt) {
      errors.push(`кадр ${shot.n}: нет промта`);
      continue;
    }
    const text = String(prompt.text ?? "");
    if (!/[a-zA-Z]{3}/.test(text)) {
      errors.push(`кадр ${shot.n}: промт не на английском`);
    }
    if (styleBlock) {
      if (!text.includes(styleBlock)) {
        errors.push(`кадр ${shot.n}: блок стиля не совпал дословно`);
      } else if (text.indexOf(styleBlock) !== text.lastIndexOf(styleBlock)) {
        errors.push(`кадр ${shot.n}: блок стиля вставлен дважды`);
      }
    }
    if (!/16:9/.test(text)) {
      warnings.push(`кадр ${shot.n}: не указана горизонтальная композиция 16:9`);
    }
  }

  const extra = prompts.filter((p) => !shots.some((s) => s.n === p.shot));
  if (extra.length) errors.push(`промты для несуществующих кадров: ${extra.map((p) => p.shot).join(", ")}`);

  return { errors, warnings, stats: { prompts: prompts.length, shots: shots.length } };
}

/** Проверка промтов к анимациям: только на кадры со значком, с запретами Veo. */
export function validateVideoPrompts({ shots, prompts, styleBlock }) {
  const errors = [];
  const warnings = [];
  const animated = shots.filter((s) => s.animated).map((s) => s.n);
  const byShot = new Map(prompts.map((p) => [p.shot, p]));

  for (const n of animated) {
    const prompt = byShot.get(n);
    if (!prompt) {
      errors.push(`кадр ${n}: анимация помечена, но промта нет`);
      continue;
    }
    const text = String(prompt.text ?? "");
    if (!/camera locked/i.test(text)) errors.push(`кадр ${n}: не сказано, что камера стоит`);
    if (!/limited motion|subtle/i.test(text)) errors.push(`кадр ${n}: не ограничено движение`);
    if (!/no (style change|morphing)/i.test(text)) errors.push(`кадр ${n}: не запрещена смена стиля`);
  }

  const idle = prompts.filter((p) => !animated.includes(p.shot));
  if (idle.length) errors.push(`промты анимации на неотмеченные кадры: ${idle.map((p) => p.shot).join(", ")}`);
  if (styleBlock) {
    for (const p of prompts) {
      if (!String(p.text ?? "").includes(styleBlock)) {
        warnings.push(`кадр ${p.shot}: в промте анимации нет блока стиля`);
      }
    }
  }

  return { errors, warnings, stats: { prompts: prompts.length, animated: animated.length } };
}

/**
 * Проверка листа персонажей: один и тот же герой должен называться одинаково.
 * Иначе в кадре 12 «the scientist», а в кадре 40 «the researcher» — и канал
 * получает двух разных людей вместо одного.
 */
export function validateCharacterSheet({ sheet = [], prompts = [], shots = [] }) {
  const errors = [];
  const warnings = [];
  if (!sheet.length) return { errors, warnings, stats: { characters: 0 } };

  const texts = [...shots.map((s) => s.onScreen ?? ""), ...prompts.map((p) => p.text ?? "")].join("\n");
  const used = [];

  for (const character of sheet) {
    if (!character.en || !character.en.trim()) {
      errors.push(`персонаж без английского описания: ${character.name ?? "?"}`);
      continue;
    }
    used.push(character.en.trim());
  }

  // Описание персонажа должно встречаться в промтах дословно, если он в кадре.
  for (const character of sheet) {
    const desc = String(character.en ?? "").trim();
    if (!desc) continue;
    if (!texts.includes(desc)) {
      warnings.push(`описание персонажа «${character.name}» ни разу не использовано дословно`);
    }
  }

  const firstWords = sheet.map((c) => String(c.en ?? "").trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase());
  const duplicates = firstWords.filter((w, i) => w && firstWords.indexOf(w) !== i);
  if (duplicates.length) {
    errors.push(`персонажи описаны одинаково и различить их нельзя: ${duplicates.join("; ")}`);
  }

  return { errors, warnings, stats: { characters: sheet.length, used: used.length } };
}

/** Свод всех проверок стадии. */
export function checkStage(stage, payload) {
  switch (stage) {
    case "script":
      return validateScript(payload);
    case "image_prompts":
      return validateImagePrompts(payload);
    case "video_prompts":
      return validateVideoPrompts(payload);
    case "style":
      return validateCharacterSheet(payload);
    default:
      return { errors: [], warnings: [], stats: {} };
  }
}
