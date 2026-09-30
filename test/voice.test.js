import { test } from "node:test";
import assert from "node:assert/strict";

import { alignShots, toSrt } from "../src/providers/voice.js";

/** Тайминги слов, как их отдаёт сервис: ровно `count` слов по 400 мс. */
function words(count, stepMs = 400) {
  return Array.from({ length: count }, (_, i) => ({
    word: `w${i + 1}`,
    startMs: i * stepMs,
    durMs: stepMs - 40,
  }));
}

test("тайминги кадров не уезжают, когда слов в сценарии больше, чем таймингов", () => {
  // Живой случай: сценарий на 2814 слов, а сервис отдал 2748 границ (числа и знаки
  // он не размечает). Прежний счёт «взять ровно столько слов, сколько в кадре» уводил
  // курсор за конец списка, и последние кадры получали начало 0 и конец всего фильма:
  // один кадр растягивался на двадцать минут и рисовался в 4K — сборка шла полчаса.
  const shots = Array.from({ length: 10 }, (_, i) => ({
    n: i + 1,
    narration: "одно два три четыре пять шесть семь восемь девять десять",
    animated: false,
  }));
  const timings = words(80); // на 20 слов меньше, чем в сценарии
  const aligned = alignShots(shots, timings);
  const durationMs = timings[timings.length - 1].startMs + timings[timings.length - 1].durMs;

  assert.equal(aligned.length, 10);
  assert.equal(aligned[aligned.length - 1].endMs, durationMs, "последний кадр закрывает фильм");

  let previous = -1;
  for (const shot of aligned) {
    assert.ok(shot.endMs > shot.startMs, `кадр ${shot.n}: конец позже начала`);
    assert.ok(shot.startMs >= previous, `кадр ${shot.n}: начало не должно идти назад`);
    previous = shot.startMs;
    const share = (shot.endMs - shot.startMs) / durationMs;
    assert.ok(share < 0.5, `кадр ${shot.n} занял ${Math.round(share * 100)}% фильма — тайминг сбит`);
  }
});

test("при точных таймингах границы берутся из речи, а не из долей", () => {
  const shots = [
    { n: 1, narration: "одно два три", animated: false },
    { n: 2, narration: "четыре пять шесть", animated: false },
    { n: 3, narration: "семь восемь девять", animated: false },
  ];
  const timings = words(9, 500);
  const aligned = alignShots(shots, timings);

  assert.equal(aligned[0].startMs, 0, "первый кадр начинается с нуля");
  assert.equal(aligned[1].startMs, timings[3].startMs, "второй кадр начинается со своего первого слова");
  assert.equal(aligned[1].words.length, 3, "кадру достались его собственные слова");
  assert.equal(aligned[2].endMs, timings[8].startMs + timings[8].durMs);
});

test("без озвучки кадры не получают выдуманных времён", () => {
  const shots = [{ n: 1, narration: "раз", animated: false }];
  const aligned = alignShots(shots, []);
  assert.equal(aligned[0].startMs, 0);
  assert.equal(aligned[0].endMs, 0);
});

test("субтитры собираются по словам с таймингом", () => {
  const srt = toSrt(words(4, 500).map((w, i) => ({ ...w, word: `слово${i + 1}` })));
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /слово1 слово2 слово3 слово4/);
});
