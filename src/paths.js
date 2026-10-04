/**
 * Где лежат проекты конвейера.
 *
 * Путь был вшит как /home/ibrohim/kadr/projects и в сервере, и в воркере: на
 * чужой машине конвейер просто не запускался, а репозиторий публичный. Теперь это
 * папка `projects/` рядом с кодом, а KADR_PROJECTS перекрывает её — этим
 * пользуются тесты и те, кто держит материалы на другом диске.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Корень репозитория: от него считаются проекты и скрипты. */
export const ROOT = resolve(HERE, "..");

export const PROJECTS = process.env.KADR_PROJECTS
  ? resolve(process.env.KADR_PROJECTS)
  : join(ROOT, "projects");
