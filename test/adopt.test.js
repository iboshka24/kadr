import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb, listProjects, createProject, stageRun } from "../src/db.js";
import { adoptProjectsFromDisk, stageDone } from "../src/adopt.js";

/**
 * Студия показывает только то, что заведено её же формой. Проект, собранный из
 * командной строки, лежит на диске целым — со сценарием, озвучкой и фильмом, — но
 * в интерфейсе его нет, и открыть его нечем. Здесь проверяется сверка: папка с
 * материалами заводится сама, папка без материалов не заводится, повторный вызов
 * ничего не дублирует.
 */

function scratch() {
  return mkdtempSync(join(tmpdir(), "kadr-adopt-"));
}

function projectDir(root, name, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, data] of Object.entries(files)) {
    writeFileSync(join(dir, file), typeof data === "string" ? data : JSON.stringify(data));
  }
  return dir;
}

test("проект с материалами заводится в базе со своими параметрами", () => {
  const root = scratch();
  projectDir(root, "ancient-night", {
    "params.json": { minutes: 15, language: "en", voice: "en-US-GuyNeural" },
    "concept.json": { title: "Nightfire: The First State-Controlled Surveillance" },
    "script.json": { shots: [{ n: 1 }, { n: 2 }] },
    "film.json": { file: "video/video.mp4" },
  });

  const db = openDb(":memory:");
  const adopted = adoptProjectsFromDisk(db, root);

  assert.equal(adopted, 1);
  const [project] = listProjects(db);
  assert.equal(project.id, "ancient-night");
  assert.equal(project.title, "Nightfire: The First State-Controlled Surveillance");
  assert.equal(project.minutes, 15);
  assert.equal(project.language, "en");
});

test("стадии с готовым материалом помечены сделанными, остальные — нет", () => {
  const root = scratch();
  projectDir(root, "ponchik", {
    "params.json": { minutes: 8 },
    "script.json": { shots: [] },
  });
  writeFileSync(join(root, "ponchik", "voice.json"), JSON.stringify({ ok: true }));

  const db = openDb(":memory:");
  adoptProjectsFromDisk(db, root);

  assert.equal(stageRun(db, "ponchik", "script").status, "done");
  assert.equal(stageRun(db, "ponchik", "voice").status, "done");
  /* Материала нет — стадия должна остаться несделанной, иначе её пропустят. */
  assert.equal(stageRun(db, "ponchik", "assemble").status, "pending");
});

test("папка без материалов проектом не считается", () => {
  const root = scratch();
  mkdirSync(join(root, "просто-папка"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });

  const db = openDb(":memory:");
  assert.equal(adoptProjectsFromDisk(db, root), 0);
  assert.equal(listProjects(db).length, 0);
});

test("озвучка и сборка считаются сделанными по своим файлам, а не по материалу", () => {
  const root = scratch();
  /* Ровно случай проекта из командной строки: voice.json и assemble.json никто
     не писал, но озвучка и фильм на диске есть. */
  projectDir(root, "ancient-night", { "script.json": { shots: [] }, "params.json": { minutes: 20 } });
  mkdirSync(join(root, "ancient-night", "voice"), { recursive: true });
  writeFileSync(join(root, "ancient-night", "voice", "voice.mp3"), "не mp3, но файл");
  mkdirSync(join(root, "ancient-night", "video"), { recursive: true });
  writeFileSync(join(root, "ancient-night", "video", "video.mp4"), "не mp4, но файл");

  const db = openDb(":memory:");
  adoptProjectsFromDisk(db, root);

  assert.equal(stageRun(db, "ancient-night", "voice").status, "done");
  assert.equal(stageRun(db, "ancient-night", "assemble").status, "done");
  assert.equal(stageDone(join(root, "ancient-night"), "voice"), true);
  assert.equal(stageDone(join(root, "ancient-night"), "assemble"), true);
  /* Озвучки нет — стадия должна остаться несделанной. */
  assert.equal(stageDone(join(root, "ponchik-без-озвучки"), "voice"), false);
});

test("папка с одним готовым фильмом всё равно опознаётся как проект", () => {
  const root = scratch();
  const dir = projectDir(root, "только-видео", {});
  mkdirSync(join(dir, "video"), { recursive: true });
  writeFileSync(join(dir, "video", "video.mp4"), "не mp4, но файл");

  const db = openDb(":memory:");
  assert.equal(adoptProjectsFromDisk(db, root), 1);
  assert.equal(listProjects(db)[0].id, "только-видео");
});

test("повторный вызов не дублирует проекты", () => {
  const root = scratch();
  projectDir(root, "ancient-night", { "script.json": { shots: [] } });

  const db = openDb(":memory:");
  adoptProjectsFromDisk(db, root);
  adoptProjectsFromDisk(db, root);
  adoptProjectsFromDisk(db, root);

  assert.equal(listProjects(db).length, 1);
});

test("битый params.json не мешает завести проект", () => {
  const root = scratch();
  projectDir(root, "broken", { "params.json": "{ это не json", "script.json": { shots: [] } });

  const db = openDb(":memory:");
  assert.equal(adoptProjectsFromDisk(db, root), 1);
  const [project] = listProjects(db);
  assert.equal(project.title, "broken");
  assert.equal(project.minutes, 8, "без параметров должно быть значение по умолчанию");
  assert.equal(project.language, "ru");
});

test("проект, заведённый в студии, сверка не переписывает", () => {
  const root = scratch();
  projectDir(root, "my-video", { "script.json": { shots: [] } });

  const db = openDb(":memory:");
  createProject(db, { id: "my-video", title: "Моё видео", minutes: 3, language: "ru" });
  adoptProjectsFromDisk(db, root);

  const [project] = listProjects(db);
  assert.equal(project.title, "Моё видео");
  assert.equal(project.minutes, 3);
});

test("название берётся из темы, если концепции ещё нет", () => {
  const root = scratch();
  projectDir(root, "topic-only", {
    "params.json": { minutes: 5 },
    "ideas.json": { topic: "Что делали древние люди ночью" },
  });

  const db = openDb(":memory:");
  adoptProjectsFromDisk(db, root);
  assert.equal(listProjects(db)[0].title, "Что делали древние люди ночью");
});

test("отсутствующая папка проектов — не ошибка", () => {
  const db = openDb(":memory:");
  assert.equal(adoptProjectsFromDisk(db, join(scratch(), "нет-такой-папки")), 0);
});
