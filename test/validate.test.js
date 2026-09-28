import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countWords,
  planFor,
  validateScript,
  validateImagePrompts,
  validateVideoPrompts,
  validateCharacterSheet,
} from "../src/validate.js";

/** Собирает раскадровку нужного размера — чтобы проверять правила, а не объём. */
function makeShots(minutes = 8, { animatedEvery = 5 } = {}) {
  const [sMin, sMax] = planFor({ minutes, script: "" }).shotsTarget;
  const count = Math.round((sMin + sMax) / 2);
  const [wMin] = planFor({ minutes, script: "" }).wordsTarget;
  const wordsPerShot = Math.ceil((minutes * 160) / count);
  const filler = Array.from({ length: wordsPerShot }, (_, i) => `слово${i}`).join(" ");
  return Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    narration: `${filler}.`,
    onScreen: `сцена ${i + 1}`,
    animated: animatedEvery > 0 && i % animatedEvery === 0,
  }));
}

test("слова считаются по буквам, а не по пробелам", () => {
  assert.equal(countWords("три слова здесь"), 3);
  assert.equal(countWords("тире — не слово"), 3);
  assert.equal(countWords(""), 0);
});

test("план на 8 минут требует 1200–1520 слов и 120–144 кадра", () => {
  const plan = planFor({ minutes: 8, script: "" });
  assert.deepEqual(plan.wordsTarget, [1200, 1520]);
  assert.deepEqual(plan.shotsTarget, [120, 144]);
});

test("сценарий нужной длины проходит без ошибок", () => {
  const shots = makeShots(8);
  const result = validateScript({ minutes: 8, shots });
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.shots, shots.length);
  assert.ok(result.stats.words >= 1200, `слов: ${result.stats.words}`);
});

test("короткий сценарий не проходит: это главная причина пустого видео", () => {
  const result = validateScript({ minutes: 8, shots: makeShots(8).slice(0, 10) });
  assert.ok(result.errors.some((e) => e.includes("кадров мало")));
});

test("кадр без озвучки или без описания экрана — ошибка", () => {
  const shots = makeShots(8);
  shots[3].narration = "   ";
  shots[7].onScreen = "";
  shots[9].animated = "да";
  const { errors } = validateScript({ minutes: 8, shots });
  assert.ok(errors.some((e) => e.includes("кадр 4: нет озвучки")));
  assert.ok(errors.some((e) => e.includes("кадр 8: не сказано")));
  assert.ok(errors.some((e) => e.includes("кадр 10: не решено")));
});

test("нумерация кадров обязана идти подряд", () => {
  const shots = makeShots(8);
  shots[5].n = 99;
  const { errors } = validateScript({ minutes: 8, shots });
  assert.ok(errors.some((e) => e.includes("номера кадров")));
});

test("слишком много анимации отклоняется: эталон сдержанный", () => {
  const shots = makeShots(8, { animatedEvery: 1 });
  const { errors } = validateScript({ minutes: 8, shots });
  assert.ok(errors.some((e) => e.includes("анимаций слишком много")));
});

test("блок стиля должен совпасть посимвольно в каждом промте", () => {
  const shots = makeShots(8);
  const block = "flat 2D hand-drawn cartoon illustration, bold ink outlines";
  const prompts = shots.map((s) => ({
    shot: s.n,
    text: `A stick figure at a table. ${block}, 16:9 horizontal composition`,
  }));
  assert.deepEqual(validateImagePrompts({ shots, prompts, styleBlock: block }).errors, []);

  prompts[4].text = prompts[4].text.replace("ink outlines", "ink outline");
  const broken = validateImagePrompts({ shots, prompts, styleBlock: block });
  assert.ok(broken.errors.some((e) => e.includes("кадр 5") && e.includes("блок стиля")));
});

test("промт не на английском не принимается", () => {
  const shots = makeShots(8);
  const prompts = shots.map((s) => ({ shot: s.n, text: "человечек за столом, 16:9" }));
  const { errors } = validateImagePrompts({ shots, prompts, styleBlock: null });
  assert.ok(errors.some((e) => e.includes("не на английском")));
});

test("двойная вставка блока стиля — ошибка", () => {
  const shots = makeShots(8);
  const block = "flat 2D hand-drawn cartoon illustration";
  const prompts = shots.map((s) => ({ shot: s.n, text: `${block} something ${block} 16:9` }));
  const { errors } = validateImagePrompts({ shots, prompts, styleBlock: block });
  assert.ok(errors.some((e) => e.includes("дважды")));
});

test("промт для несуществующего кадра — ошибка", () => {
  const shots = makeShots(8);
  const prompts = [...shots.map((s) => ({ shot: s.n, text: "some english text 16:9" })), { shot: 999, text: "x 16:9" }];
  const { errors } = validateImagePrompts({ shots, prompts, styleBlock: null });
  assert.ok(errors.some((e) => e.includes("несуществующих")));
});

test("анимация требуется ровно на помеченные кадры", () => {
  const shots = makeShots(8);
  const animated = shots.filter((s) => s.animated);
  const prompts = animated.map((s) => ({
    shot: s.n,
    text: "Animate this flat 2D drawing. Subtle limited motion only. Camera locked, no zoom, no morphing, no style change.",
  }));
  assert.deepEqual(validateVideoPrompts({ shots, prompts }).errors, []);

  const missing = validateVideoPrompts({ shots, prompts: prompts.slice(1) });
  assert.ok(missing.errors.some((e) => e.includes("промта нет")));

  const extra = validateVideoPrompts({
    shots,
    prompts: [...prompts, { shot: shots.find((s) => !s.animated).n, text: "subtle limited motion, camera locked, no morphing" }],
  });
  assert.ok(extra.errors.some((e) => e.includes("неотмеченные")));
});

test("промт анимации без запрета смены стиля отклоняется", () => {
  const shots = makeShots(8);
  const animated = shots.filter((s) => s.animated)[0];
  const { errors } = validateVideoPrompts({
    shots,
    prompts: [{ shot: animated.n, text: "Animate this, subtle limited motion, camera locked." }],
  });
  assert.ok(errors.some((e) => e.includes("не запрещена смена стиля")));
});

test("два персонажа с одинаковым описанием неразличимы", () => {
  const sheet = [
    { name: "учёный", en: "a tall stick figure with round glasses" },
    { name: "инженер", en: "a tall stick figure with round glasses" },
  ];
  const { errors } = validateCharacterSheet({ sheet, prompts: [], shots: [] });
  assert.ok(errors.some((e) => e.includes("различить их нельзя")));
});

test("описание персонажа, не попавшее ни в один кадр, поднимает предупреждение", () => {
  const sheet = [{ name: "учёный", en: "a stick figure in a white lab coat" }];
  const { warnings } = validateCharacterSheet({
    sheet,
    prompts: [{ shot: 1, text: "a desk with papers" }],
    shots: [{ n: 1, onScreen: "стол" }],
  });
  assert.ok(warnings.some((w) => w.includes("ни разу не использовано")));
});
