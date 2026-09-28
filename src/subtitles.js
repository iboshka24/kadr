/**
 * Субтитры: разметка ASS с подсветкой произносимого слова.
 *
 * Почему не srt. Обычные субтитры показывают строку целиком и не показывают, где
 * сейчас голос: на быстрой речи глаз не успевает. Приём, который делают
 * инструменты нарезки клипов (SupoClip и подобные) — делить речь на короткие
 * группы и подсвечивать то слово, которое звучит прямо сейчас. Тайминги у нас уже
 * есть по каждому слову (их отдаёт голосовой сервис), поэтому подсветка точная, а
 * не на глазок.
 *
 * Как это устроено в ASS. У одного события одна строка, поэтому группа из N слов
 * даёт N событий: каждое показывает всю строку целиком, но разным цветом выделяет
 * своё слово. Так текст не дёргается — меняется только подсветка.
 */

/** Экранирование: в ASS фигурные скобки и обратный слэш — служебные. */
function escapeAss(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, " ");
}

const WHITE = "&H00FFFFFF";
const AMBER = "&H003DA3E8"; // #E8A33D в порядке ASS (BGR)
const BAR_BLACK = "&H26000000"; // чёрная полоса, чуть прозрачная

/**
 * Группирует слова в короткие строки.
 *
 * Строка не длиннее `maxWords` слов и `maxChars` знаков. Это не косметика: длинная
 * строка с подсветкой читается хуже обычных субтитров, потому что глаз ищет конец
 * строки, пока голос уже ушёл вперёд.
 */
export function groupWords(words, { maxWords = 4, maxChars = 30 } = {}) {
  const groups = [];
  let current = [];

  for (const word of words) {
    const candidate = [...current, word];
    const text = candidate.map((w) => w.word).join(" ");
    if (current.length >= maxWords || text.length > maxChars) {
      if (current.length) groups.push(current);
      current = [word];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Время в формате ASS: H:MM:SS.cc */
function assTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.round((total % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/**
 * Собирает файл ASS.
 *
 * @param {Array<{word:string,startMs:number,durMs:number}>} words тайминги слов от голоса
 * @param {object} [options]
 * @param {number} [options.fontSize] размер шрифта в единицах кадра
 * @param {string} [options.font] имя установленного шрифта
 * @param {boolean} [options.uppercase] писать заглавными (клиповый вид)
 * @param {number} [options.maxWords] слов в строке
 * @param {number} [options.marginBottom] отступ снизу
 * @returns {string}
 */
export function buildAss(words, options = {}) {
  const {
    fontSize = 62,
    font = "DejaVu Sans",
    uppercase = false,
    maxWords = 4,
    maxChars = 30,
    marginBottom = 118,
    // Полоса под текст. В примерах канала субтитры стоят на сплошной чёрной
    // полосе, а не висят на картинке: так они читаются на любом фоне.
    bar = true,
    barHeight = 96,
  } = options;

  const header = `[Script Info]
; Субтитры с подсветкой произносимого слова. Собрано конвейером kadr.
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${fontSize},${WHITE},${WHITE},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,60,60,${marginBottom},1
Style: Bar,${font},20,&H00000000,&H00000000,${BAR_BLACK},${BAR_BLACK},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  if (!Array.isArray(words) || words.length === 0) return `${header}\n`;

  const lastWord = words[words.length - 1];
  const lastMs = lastWord.startMs + Math.max(lastWord.durMs ?? 0, 500);

  const lines = [];

  // Полоса: одно событие на весь ролик, нарисованное прямоугольником. Именно
  // поэтому она ровная — если рисовать её под каждым текстом, ширина прыгала бы
  // вместе с длиной строки. Полоса чуть шире текста и не двигается.
  if (bar) {
    const barTop = 1080 - marginBottom - Math.round(fontSize * 0.62) - 18;
    const height = barHeight;
    const drawn =
      `{\\an7\\pos(0,${barTop})\\p1}m 0 0 l 1920 0 l 1920 ${height} l 0 ${height}{\\p0}`;
    lines.push(`Dialogue: 0,${assTime(0)},${assTime(lastMs)},Bar,,0,0,0,,${drawn}`);
  }

  for (const group of groupWords(words, { maxWords, maxChars })) {
    const wordsInGroup = group.map((w) => (uppercase ? String(w.word).toUpperCase() : w.word));

    group.forEach((word, index) => {
      // Событие живёт от начала своего слова до начала следующего: так подсветка
      // перескакивает ровно тогда, когда голос произносит следующее слово.
      const start = word.startMs;
      const end = index + 1 < group.length
        ? group[index + 1].startMs
        : word.startMs + Math.max(word.durMs ?? 0, 120);

      const text = wordsInGroup
        .map((w, i) => (i === index ? `{\\c${AMBER}}${escapeAss(w)}{\\c${WHITE}}` : escapeAss(w)))
        .join(" ");

      // Слой 1 — текст поверх полосы (слой 0).
      lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    });
  }

  return `${header}\n${lines.join("\n")}\n`;
}

/** Обычный srt — оставлен для площадок, которые просят отдельный файл субтитров. */
export function toSrt(words, { maxWords = 7, maxChars = 54 } = {}) {
  if (!Array.isArray(words) || words.length === 0) return "";
  const groups = groupWords(words, { maxWords, maxChars });
  const time = (ms) => {
    const total = Math.max(0, Math.round(ms));
    const hours = String(Math.floor(total / 3600000)).padStart(2, "0");
    const minutes = String(Math.floor((total % 3600000) / 60000)).padStart(2, "0");
    const seconds = String(Math.floor((total % 60000) / 1000)).padStart(2, "0");
    const millis = String(total % 1000).padStart(3, "0");
    return `${hours}:${minutes}:${seconds},${millis}`;
  };

  return groups
    .map((group, index) => {
      const start = group[0].startMs;
      const last = group[group.length - 1];
      const end = last.startMs + Math.max(last.durMs ?? 0, 300);
      const text = group.map((w) => w.word).join(" ");
      return `${index + 1}\n${time(start)} --> ${time(end)}\n${text}\n`;
    })
    .join("\n");
}
