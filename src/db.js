/**
 * Хранилище конвейера.
 *
 * Одна база на всё: проекты (одно видео = один проект), стадии, задания очереди и
 * материалы. Взято встроенное `node:sqlite` — конвейер не должен требовать ни
 * сервера базы, ни установки пакетов: его ставят на ноутбук и запускают.
 *
 * Почему стадии — строки в базе, а не файлы: длинный сценарий стоит денег и
 * времени, и обрыв на седьмой стадии не должен стирать первые шесть. Состояние
 * восстанавливается после перезапуска, а дорогие шаги кэшируются.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STAGES = [
  "transcript",
  "niche",
  "style",
  "params",
  "script",
  "image_prompts",
  "video_prompts",
  "voice",
  "assemble",
];

/** Стадии, которые зовут модель: их выполнение стоит времени и квоты. */
export const MODEL_STAGES = STAGES.filter((s) => !["voice", "assemble"].includes(s));

export function openDb(file = "projects/kadr.db") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      minutes       REAL NOT NULL DEFAULT 8,
      language      TEXT NOT NULL DEFAULT 'ru',
      niche         TEXT,
      style_block   TEXT,
      character_sheet TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- Результат каждой стадии: дорогие шаги не пересчитываются дважды.
    CREATE TABLE IF NOT EXISTS stage_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      stage       TEXT NOT NULL,
      status      TEXT NOT NULL,            -- pending | running | done | failed
      input       TEXT,                     -- JSON, что подали на вход
      output      TEXT,                     -- JSON, что получили
      error       TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      started_at  TEXT,
      finished_at TEXT,
      UNIQUE (project_id, stage)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      stage       TEXT NOT NULL,
      status      TEXT NOT NULL,            -- queued | running | done | failed
      priority    INTEGER NOT NULL DEFAULT 100,
      attempts    INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error       TEXT,
      created_at  TEXT NOT NULL,
      started_at  TEXT,
      finished_at TEXT
    );

    -- Панели, озвучка, клипы: всё, что лежит на диске и стоит денег.
    CREATE TABLE IF NOT EXISTS assets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      shot        INTEGER,
      kind        TEXT NOT NULL,            -- panel | clip | voice | subtitle | video
      path        TEXT NOT NULL,
      meta        TEXT,
      created_at  TEXT NOT NULL,
      UNIQUE (project_id, shot, kind)
    );

    CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, priority, id);
    CREATE INDEX IF NOT EXISTS assets_project ON assets (project_id, shot);
  `);

  return db;
}

const now = () => new Date().toISOString();

export function createProject(db, { id, title, minutes = 8, language = "ru" }) {
  db.prepare(
    `INSERT INTO projects (id, title, minutes, language, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, title, minutes, language, now(), now());
  for (const stage of STAGES) {
    db.prepare(
      `INSERT INTO stage_runs (project_id, stage, status, attempts) VALUES (?, ?, 'pending', 0)`,
    ).run(id, stage);
  }
  return getProject(db, id);
}

export function getProject(db, id) {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) ?? null;
}

export function listProjects(db) {
  return db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all();
}

export function setProject(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    now(),
    id,
  );
}

export function stageRun(db, projectId, stage) {
  return (
    db
      .prepare(`SELECT * FROM stage_runs WHERE project_id = ? AND stage = ?`)
      .get(projectId, stage) ?? null
  );
}

export function allStageRuns(db, projectId) {
  return db
    .prepare(`SELECT * FROM stage_runs WHERE project_id = ? ORDER BY id`)
    .all(projectId);
}

export function markStage(db, projectId, stage, status, { input, output, error } = {}) {
  db.prepare(
    `UPDATE stage_runs
        SET status = ?,
            input = COALESCE(?, input),
            output = COALESCE(?, output),
            error = ?,
            attempts = attempts + ?,
            started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
            finished_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE finished_at END
      WHERE project_id = ? AND stage = ?`,
  ).run(
    status,
    input === undefined ? null : JSON.stringify(input),
    output === undefined ? null : JSON.stringify(output),
    error ?? null,
    status === "running" ? 1 : 0,
    status,
    now(),
    status,
    now(),
    projectId,
    stage,
  );
}

export function enqueue(db, projectId, stage, priority = 100) {
  const existing = db
    .prepare(
      `SELECT id FROM jobs WHERE project_id = ? AND stage = ? AND status IN ('queued','running')`,
    )
    .get(projectId, stage);
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO jobs (project_id, stage, status, priority, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    )
    .run(projectId, stage, priority, now());
  return Number(info.lastInsertRowid);
}

/** Берёт одно задание из очереди. Атомарность даёт сам SQLite, а не надежда. */
export function claimJob(db, stage = null) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT * FROM jobs
          WHERE status = 'queued' ${stage ? "AND stage = ?" : ""}
          ORDER BY priority ASC, id ASC LIMIT 1`,
      )
      .get(...(stage ? [stage] : []));
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(
      `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?`,
    ).run(now(), row.id);
    db.exec("COMMIT");
    return { ...row, status: "running", attempts: row.attempts + 1 };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function finishJob(db, id, status, error = null) {
  db.prepare(`UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?`).run(
    status,
    error,
    now(),
    id,
  );
}

export function queueDepth(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')`).get().n;
}

export function putAsset(db, { projectId, shot = null, kind, path, meta = null }) {
  db.prepare(
    `INSERT INTO assets (project_id, shot, kind, path, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, shot, kind) DO UPDATE SET path = excluded.path, meta = excluded.meta`,
  ).run(projectId, shot, kind, path, meta ? JSON.stringify(meta) : null, now());
}

export function assetsOf(db, projectId, kind = null) {
  return db
    .prepare(
      `SELECT * FROM assets WHERE project_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY shot`,
    )
    .all(...(kind ? [projectId, kind] : [projectId]));
}

export function assetFor(db, projectId, shot, kind) {
  return (
    db
      .prepare(`SELECT * FROM assets WHERE project_id = ? AND shot = ? AND kind = ?`)
      .get(projectId, shot, kind) ?? null
  );
}
