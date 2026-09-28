import test from "node:test";
import assert from "node:assert/strict";

import { groupWords, buildAss, toSrt } from "../src/subtitles.js";

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
  const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  assert.equal(events.length, words.length, "событий столько же, сколько слов");

  // Первое событие подсвечивает первое слово и гасит следующее.
  assert.ok(events[0].includes("Посмотри"), "первое слово попало в текст");
  assert.ok(events[0].indexOf("&H003DA3E8") < events[0].indexOf("на"), "подсветка стоит на первом слове");

  // Второе событие — подсветка уже на втором слове.
  const second = events[1].indexOf("&H003DA3E8");
  assert.ok(second > 0 && events[1].slice(second).includes("на"), "подсветка перешла на второе слово");
});

test("подсветка перескакивает в момент начала слова, без дырок", () => {
  const ass = buildAss(words, { maxWords: 4 });
  const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  const starts = events.map((e) => e.split(",")[1]);
  assert.equal(starts[0], "0:00:00.00");
  // Каждое событие начинается там, где начинается его слово.
  assert.equal(starts[1], "0:00:00.50");
  assert.equal(starts[2], "0:00:00.70");
});

test("служебные знаки ASS экранируются", () => {
  const ass = buildAss([{ word: "a{b}c\\d", startMs: 0, durMs: 400 }]);
  const event = ass.split("\n").find((l) => l.startsWith("Dialogue:"));
  assert.ok(event.includes("\\{b\\}"), "фигурные скобки не остаются служебными");
});

test("без слов файл всё равно корректный", () => {
  const ass = buildAss([]);
  assert.ok(ass.includes("[Events]"));
  assert.equal(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length, 0);
  assert.equal(toSrt([]), "");
});
