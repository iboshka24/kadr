/**
 * Сверка базы с диском: студия должна видеть проекты, сделанные не ею.
 *
 * Список проектов в интерфейсе берётся из базы, а база наполняется только формой
 * «создать видео». Но конвейер пускают и из командной строки — `scripts/demo.mjs`,
 * `run-long.sh`, — и тогда папка со сценарием, озвучкой и готовым фильмом лежит на
 * диске, а в интерфейсе её нет: открыть такой проект нечем. Здесь найденные папки
 * заводятся в базе по своим же материалам.
 *
 * Почему угадываем по файлам, а не по имени папки: в `projects/` попадает и база
 * (`kadr.db`), и рабочие каталоги. Проектом считается только папка, где есть
 * материалы конвейера.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createProject, listProjects, markStage, STAGES } from "./db.js";

/** Материалы, по которым папка опознаётся как проект. */
export const PROJECT_MARKERS = [
  "params.json",
  "script.json",
  "concept.json",
  "film.json",
  "timed_shots.json",
  "voice/voice.mp3",
  "video/video.mp4",
];

/** Читает материал; битый файл не должен ронять весь список проектов. */
function readArtifact(dir, name) {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Где искать результат стадии, у которой своего материала нет.
 *
 * Озвучка и сборка не пишут `voice.json` / `assemble.json` — их результат лежит
 * готовыми файлами. Конвейер из командной строки (scripts/demo.mjs) этих
 * материалов не оставляет вовсе, и проект с готовым фильмом показывался как
 * «озвучка не начата». Поэтому стадия считается сделанной и по своему результату.
 */
const STAGE_OUTPUTS = {
  voice: ["voice/voice.mp3"],
  assemble: ["video/video.mp4"],
};

/** Сделана ли стадия: сначала её материал, иначе — её результат на диске. */
export function stageDone(dir, stage) {
  if (existsSync(join(dir, `${stage}.json`))) return true;
  return (STAGE_OUTPUTS[stage] ?? []).some((rel) => existsSync(join(dir, rel)));
}

/**
 * Заводит в базе проекты, найденные на диске.
 *
 * Возвращает, сколько проектов завелось. Повторный вызов ничего не дублирует:
 * уже известные папки пропускаются, поэтому функцию можно звать на каждый запрос.
 */
export function adoptProjectsFromDisk(db, projectsDir) {
  if (!existsSync(projectsDir)) return 0;

  const known = new Set(listProjects(db).map((p) => p.id));
  let adopted = 0;

  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    const dir = join(projectsDir, entry.name);
    if (!PROJECT_MARKERS.some((f) => existsSync(join(dir, f)))) continue;

    const params = readArtifact(dir, "params");
    const concept = readArtifact(dir, "concept");
    const ideas = readArtifact(dir, "ideas");
    const project = createProject(db, {
      id: entry.name,
      title: String(concept?.title || ideas?.topic || entry.name).slice(0, 120),
      minutes: Number(params?.minutes) || 8,
      language: params?.language === "en" ? "en" : "ru",
    });

    /* Стадии, чей материал или результат уже лежит на диске, — сделанные: иначе
       проект с готовым фильмом выглядел бы нетронутым и его тянули бы заново. */
    for (const stage of STAGES) {
      if (stageDone(dir, stage)) markStage(db, project.id, stage, "done");
    }
    adopted += 1;
  }

  return adopted;
}
