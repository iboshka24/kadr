import test from "node:test";
import assert from "node:assert/strict";

import { groupWords, buildAss, toSrt } from "../src/subtitles.js";

/** Только события текста: первым в файле идёт событие полосы. */
const textEvents = (ass) =>
  ass.split("\n").filter((line) => line.startsWith("Dialogue: 1,"));

const words = [
  { word: "Посмотри", startMs: 0, durMs: 500 },
  { word: "на", startMs: 500, durMs: 200 },
  { word: "этот", startMs: 700, durMs: 300 },
  { word: "пончик,", startMs: 1000, durMs: 600 },
  { word: "он", startMs: 1700, durMs: 200 },
  { word: "стоит", startMs: 1900, durMs: 400 },
  { word: "меньше", startMs: 2300, durMs: 400 },
  { word: "доллара", startMs: 2700, durMs: 500 },
];

test("строка не длиннее заданного числа слов", () => {
  const groups = groupWords(words, { maxWords: 3, maxChars: 100 });
  assert.deepEqual(groups.map((g) => g.length), [3, 3, 2]);
});

test("строка не длиннее заданного числа знаков", () => {
  const groups = groupWords(words, { maxWords: 10, maxChars: 12 });
  for (const group of groups) {
    assert.ok(group.map((w) => w.word).join(" ").length <= 12 || group.length === 1);
  }
});

test("подсветка: на каждое слово группы — своё событие", () => {
  const ass = buildAss(words, { maxWords: 4 });
  const events = textEvents(ass);
  assert.equal(events.length, words.length, "событий столько же, сколько слов");

  // Первое событие подсвечивает первое слово и гасит следующее.
  assert.ok(events[0].includes("Посмотри"), "первое слово попало в текст");
  assert.ok(events[0].indexOf("&H002828D6") < events[0].indexOf("на"), "подсветка стоит на первом слове");

  // Второе событие — подсветка уже на втором слове.
  const second = events[1].indexOf("&H002828D6");
  assert.ok(second > 0 && events[1].slice(second).includes("на"), "подсветка перешла на второе слово");
});

test("подсветка перескакивает в момент начала слова, без дырок", () => {
  const ass = buildAss(words, { maxWords: 4 });
  const starts = textEvents(ass).map((e) => e.split(",")[1]);
  assert.equal(starts[0], "0:00:00.00");
  // Каждое событие начинается там, где начинается его слово.
  assert.equal(starts[1], "0:00:00.50");
  assert.equal(starts[2], "0:00:00.70");
});

test("служебные знаки ASS экранируются", () => {
  const ass = buildAss([{ word: "a{b}c\\d", startMs: 0, durMs: 400 }]);
  const event = textEvents(ass)[0];
  assert.ok(event.includes("\\{b\\}"), "фигурные скобки не остаются служебными");
});

test("без слов файл всё равно корректный", () => {
  const ass = buildAss([]);
  assert.ok(ass.includes("[Events]"));
  assert.equal(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length, 0);
  assert.equal(toSrt([]), "");
});

test("по умолчанию полосы под текстом нет, а буквы видно за счёт обводки", () => {
  // На кадрах канала половина площади — белая бумага, и сплошная чёрная полоса на
  // белом выглядела чужой плашкой. Поэтому фон убран, а читаемость держит обводка:
  // чёрные буквы с белым контуром видно и на бумаге, и на ночной синеве.
  const ass = buildAss(words, { maxWords: 4 });
  const bars = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
  assert.equal(bars.length, 0, "полосы быть не должно");

  const caption = ass.split("\n").find((l) => l.startsWith("Style: Caption"));
  const fields = caption.split(",");
  assert.equal(fields[3], "&H00000000", "буквы чёрные");
  assert.equal(fields[5], "&H00FFFFFF", "обводка белая");
  assert.ok(Number(fields[16]) >= 3, "обводка должна быть заметной");
});

test("полосу можно вернуть: тогда она одна на весь ролик и буквы белые", () => {
  const ass = buildAss(words, { maxWords: 4, bar: true });
  const bars = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
  assert.equal(bars.length, 1, "полоса должна быть ровно одна на весь ролик, а не под каждой строкой");

  // Полоса начинается с нуля и тянется до последнего слова.
  const [, start, end] = bars[0].split(",");
  assert.equal(start, "0:00:00.00");
  const last = words[words.length - 1];
  const expected = Math.round((last.startMs + last.durMs) / 10);
  const actual = Number(end.split(":")[2].replace(".", ""));
  assert.ok(Math.abs(actual - expected) < 60, "полоса кончается там же, где речь");

  // Рисуется прямоугольником на всю ширину кадра — отсюда и постоянная ширина.
  assert.ok(bars[0].includes("l 1920 0"), "полоса нарисована во всю ширину");

  const caption = ass.split("\n").find((l) => l.startsWith("Style: Caption"));
  assert.equal(caption.split(",")[3], "&H00FFFFFF", "на тёмной полосе буквы белые");
});

test("текст лежит поверх полосы, а не под ней", () => {
  const ass = buildAss(words, { maxWords: 4, bar: true });
  const barLayer = Number(ass.split("\n").find((l) => l.startsWith("Dialogue: 0,")).split(",")[0].split(" ")[1]);
  const textLayers = textEvents(ass).map((l) => Number(l.split(",")[0].split(" ")[1]));
  assert.ok(textLayers.every((layer) => layer > barLayer), "текст обязан быть выше полосы");
});
