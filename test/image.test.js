import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { panelFromInbox, inboxReport, collectPanels } from "../src/providers/image.js";

/** Проект-пустышка с папкой инбокса. */
function project(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kadr-"));
  if (Object.keys(files).length) {
    mkdirSync(join(dir, "images"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, "images", name), content);
    }
  }
  return dir;
}

const shots = [1, 2, 3].map((n) => ({ n, narration: "текст", onScreen: "кадр", animated: false }));

test("картинка кадра находится по любому имени и расширению", () => {
  const single = project({ "2.png": "x" });
  assert.ok(panelFromInbox({ projectDir: single, shotNumber: 2 })?.endsWith("2.png"));

  const dir = project({ "003.jpg": "x", "10.webp": "x" });
  assert.ok(panelFromInbox({ projectDir: dir, shotNumber: 3 })?.endsWith("003.jpg"));
  assert.ok(panelFromInbox({ projectDir: dir, shotNumber: 10 })?.endsWith("10.webp"));
  assert.equal(panelFromInbox({ projectDir: dir, shotNumber: 7 }), null);
});

test("без папки инбокса поиск не падает", () => {
  assert.equal(panelFromInbox({ projectDir: project(), shotNumber: 1 }), null);
});

test("отчёт по инбоксу считает, сколько кадров уже закрыто", () => {
  const dir = project({ "1.png": "x", "3.png": "x" });
  assert.deepEqual(inboxReport({ projectDir: dir, shots }), { ready: 2, total: 3 });
});

test("картинки из инбокса не оспариваются провайдером", async () => {
  const dir = project({ "1.png": "x", "2.png": "x" });
  const result = await collectPanels({
    projectDir: dir,
    shots,
    prompts: [{ shot: 3, text: "prompt" }],
    env: {},
    log: () => {},
  });
  // Два кадра закрыты руками, третий уходит провайдеру — а его нет, значит код.
  assert.equal(result.rendered.size, 2);
  assert.equal(result.rendered.get(1), join(dir, "images", "1.png"));
  assert.deepEqual(result.drawn, [3]);
  assert.equal(result.provider, "none");
});

test("недоступный провайдер даёт причину, а не падение", async () => {
  const result = await collectPanels({ projectDir: project(), shots, prompts: [], env: {}, log: () => {} });
  assert.equal(result.provider, "none");
  assert.ok(result.reasons.some((r) => r.includes("NVIDIA_API_KEY")), "причина по NVIDIA обязана быть названа");
  assert.ok(result.reasons.some((r) => r.includes("GEMINI_API_KEY")), "причина по Gemini обязана быть названа");
});
