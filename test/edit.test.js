import { test } from "node:test";
import assert from "node:assert/strict";

import { rewriteTask, applyRewrite, staleStages, scriptOf, EDITABLE } from "../src/edit.js";

/**
 * Правка одного кадра моделью — единственный способ поправить реплику, не гоняя
 * сорокаминутную стадию сценария. Поэтому все проверки здесь про одно: плохой
 * ответ модели не должен стоить кадра и не должен утащить за собой язык фильма.
 */

const shot = {
  n: 7,
  narration: "You walk into a brightly lit space, feeling a subtle pull towards the back.",
  onScreen: "SUPERMARKET: THE UNSEEN PULL",
  animated: true,
};

test("задача прямо называет язык, иначе правка переведёт фильм", () => {
  const task = rewriteTask(shot, { instruction: "короче" });
  assert.match(task.system, /Пиши по-английски/);
  assert.ok(!/Пиши по-русски/.test(task.system), "русское правило в английской задаче — приглашение к переводу");

  const ru = rewriteTask(
    { n: 3, narration: "Ты заходишь в ярко освещённый зал и чувствуешь тягу назад.", onScreen: "МАГАЗИН" },
    {},
  );
  assert.match(ru.system, /Пиши по-русски/);
});

test("в задаче есть реплика кадра, номер и запрет трогать другие кадры", () => {
  const task = rewriteTask(shot, { instruction: "сделай зловещее" });
  assert.match(task.user, /You walk into a brightly lit space/);
  assert.match(task.user, /сделай зловещее/);
  assert.match(task.user, /Кадр 7/);
  assert.match(task.system, /Других кадров нет/);
});

test("стиль канала подставляется, когда он есть", () => {
  const withStyle = rewriteTask(shot, { style: "спокойный триллер-разбор" });
  assert.match(withStyle.system, /спокойный триллер-разбор/);
  assert.ok(!/Стиль канала/.test(rewriteTask(shot, {}).system));
});

test("пределы полей — в подсказке, а не только в проверке", () => {
  const task = rewriteTask(shot, {});
  assert.match(task.system, new RegExp(String(EDITABLE.onScreen.max)));
});

test("поле правки обязательно из списка", () => {
  assert.throws(() => rewriteTask(shot, { field: "prompt" }), /не правится/);
  assert.throws(() => applyRewrite(shot, {}, { field: "prompt" }), /не правится/);
});

test("хороший ответ принимается, номер и метка анимации остаются", () => {
  const { shot: next, changed, rejected } = applyRewrite(shot, {
    narration: "The doors slide open. Something in the back of the store is pulling at you.",
    onScreen: "THE UNSEEN PULL",
  });
  assert.equal(changed, true);
  assert.deepEqual(rejected, []);
  assert.match(next.narration, /doors slide open/);
  assert.equal(next.onScreen, "THE UNSEEN PULL");
  assert.equal(next.n, 7);
  assert.equal(next.animated, true);
});

test("пустой ответ не стирает кадр", () => {
  for (const answer of [{}, { narration: "   " }, null, undefined, { narration: 42 }]) {
    const { shot: next, changed, rejected } = applyRewrite(shot, answer);
    assert.equal(changed, false, `ответ ${JSON.stringify(answer)} не должен менять кадр`);
    assert.equal(next.narration, shot.narration);
    assert.equal(rejected.length, 1);
  }
});

test("слишком длинная реплика не принимается", () => {
  const long = "x".repeat(EDITABLE.narration.max + 1);
  const { shot: next, changed, rejected } = applyRewrite(shot, { narration: long });
  assert.equal(changed, false);
  assert.equal(next.narration, shot.narration);
  assert.match(rejected[0], /знаков при пределе/);
});

test("перевод кадра на другой язык отвергается", () => {
  const { shot: next, changed, rejected } = applyRewrite(shot, {
    narration: "Двери разъезжаются, и что-то в глубине зала тянет тебя назад.",
  });
  assert.equal(changed, false);
  assert.equal(next.narration, shot.narration);
  assert.match(rejected[0], /другом языке/);
});

test("русский кадр так же защищён от английского ответа", () => {
  const ru = { n: 2, narration: "Ты заходишь в зал и чувствуешь тягу назад.", onScreen: "МАГАЗИН" };
  const { changed, rejected } = applyRewrite(ru, { narration: "You walk into the hall." });
  assert.equal(changed, false);
  assert.match(rejected[0], /другом языке/);
});

test("длинная надпись отвергается, а реплика всё равно применяется", () => {
  const { shot: next, changed, rejected } = applyRewrite(shot, {
    narration: "The doors slide open.",
    onScreen: "S".repeat(EDITABLE.onScreen.max + 5),
  });
  assert.equal(changed, true);
  assert.equal(next.narration, "The doors slide open.");
  assert.equal(next.onScreen, shot.onScreen, "испорченную надпись в кадр писать нельзя");
  assert.match(rejected[0], /надпись в кадре/);
});

test("правка надписи не трогает реплику", () => {
  const { shot: next, changed } = applyRewrite(shot, { onScreen: "NEW CAPTION" }, { field: "onScreen" });
  assert.equal(changed, true);
  assert.equal(next.onScreen, "NEW CAPTION");
  assert.equal(next.narration, shot.narration);
});

test("надпись на чужом языке отвергается: кадр задаёт язык фильма", () => {
  const { shot: next, changed, rejected } = applyRewrite(shot, {
    narration: "The doors slide open.",
    onScreen: "ЦЕНА СЛАДОСТИ",
  });
  assert.equal(next.onScreen, shot.onScreen, "английская подпись не должна стать русской");
  assert.equal(changed, true, "реплика принята — отвергнута только надпись");
  assert.deepEqual(rejected, ["надпись в кадре: ответ на другом языке"]);
});

test("пустая надпись в ответе — не правка", () => {
  const { shot: next, rejected } = applyRewrite(shot, { narration: "The doors slide open.", onScreen: "  " });
  assert.equal(next.onScreen, shot.onScreen);
  assert.deepEqual(rejected, []);
});

test("зависящие стадии называются только после настоящей правки", () => {
  assert.deepEqual(staleStages(true), ["image_prompts", "video_prompts", "voice", "assemble"]);
  assert.deepEqual(staleStages(false), []);
});

test("язык определяется по буквам, а не по коду проекта", () => {
  assert.equal(scriptOf("hello there"), "latin");
  assert.equal(scriptOf("привет, как дела"), "cyrillic");
  assert.equal(scriptOf("2024 — 15%"), "unknown");
  assert.equal(scriptOf(""), "unknown");
  assert.equal(scriptOf("iPhone в кармане"), "cyrillic", "смешанный текст — решает большинство букв");
});
