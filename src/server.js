/**
 * Сервер: интерфейс сценариста и API.
 *
 * Запускается одной командой, без сборки и без зависимостей. Задача сервера —
 * показывать состояние конвейера и позволять дёргать стадии по одной: длинное
 * видео дешевле доводить по шагам, глядя на результат, чем запускать всё вслепую.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, createProject, getProject, listProjects, allStageRuns, enqueue, queueDepth, assetsOf, STAGES, setProject, markStage } from "./db.js";
import { loadEnv, providersAvailable, askJson } from "./providers/llm.js";
import { VOICES } from "./providers/voice.js";
import { panelSvg } from "./providers/render.js";
import { adoptProjectsFromDisk, stageDone } from "./adopt.js";
import { rewriteTask, applyRewrite, staleStages } from "./edit.js";
import { PROJECTS } from "./paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "ui");
const PORT = Number(process.env.PORT || 4173);

const db = openDb(join(PROJECTS, "kadr.db"));
const env = loadEnv();

/* Сверка с диском — один раз при старте, а не только на запросе списка: иначе
   свежий процесс отвечает «проект не найден» на правку кадра и на запуск стадии,
   хотя проект лежит на диске целым. */
const adoptedAtStart = adoptProjectsFromDisk(db, PROJECTS);
if (adoptedAtStart) console.log(`kadr: завёл с диска проектов — ${adoptedAtStart}`);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".srt": "text/plain; charset=utf-8",
};

const json = (res, data, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const stageArtifact = (projectId, stage) => {
  const file = join(PROJECTS, projectId, `${stage}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* Битый материал одной стадии не должен закрывать весь экран проекта. */
    return null;
  }
};

/**
 * Записывает сценарий так, чтобы обрыв не стоил работы.
 *
 * Правка одного кадра переписывает script.json — файл, из которого собран готовый
 * фильм. Пишем через временный файл и переименование (половина сценария на диске
 * хуже, чем несохранённая правка) и оставляем два отката: `script.json.bak` — то,
 * что было до первой правки в студии, `script.json.prev` — состояние до этой.
 */
function writeScript(dir, script) {
  const file = join(dir, "script.json");
  const text = `${JSON.stringify(script, null, 2)}\n`;
  if (existsSync(file)) {
    const before = readFileSync(file);
    const original = join(dir, "script.json.bak");
    if (!existsSync(original)) writeFileSync(original, before);
    writeFileSync(join(dir, "script.json.prev"), before);
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Состояние проекта: стадии, материалы, что готово, где заминка. */
function projectState(id) {
  const project = getProject(db, id);
  if (!project) return null;

  const runs = allStageRuns(db, id);
  const projectDir = join(PROJECTS, id);
  const stages = STAGES.map((stage) => {
    const run = runs.find((r) => r.stage === stage);
    const artifact = stageArtifact(id, stage);
    return {
      stage,
      status: run?.status ?? "pending",
      error: run?.error ?? null,
      attempts: run?.attempts ?? 0,
      /* Готовность — по диску, а не по базе: у озвучки и сборки материала нет
         вовсе, их результат лежит готовыми файлами. */
      ready: stageDone(projectDir, stage),
      summary: summarize(stage, artifact),
    };
  });

  const script = stageArtifact(id, "script");
  const shots = script?.shots ?? [];
  const assets = assetsOf(db, id);
  const film = stageArtifact(id, "film");

  return {
    project,
    stages,
    shots,
    timed: stageArtifact(id, "timed_shots"),
    prompts: stageArtifact(id, "image_prompts")?.prompts ?? [],
    videoPrompts: stageArtifact(id, "video_prompts")?.prompts ?? [],
    assets,
    film,
    queue: queueDepth(db),
  };
}

/** Короткая сводка по стадии: цифры вместо «готово». */
function summarize(stage, artifact) {
  if (!artifact) return null;
  switch (stage) {
    case "style":
      return { styleBlock: artifact.styleBlock, characters: artifact.characterSheet?.length ?? 0 };
    case "params":
      return {
        words: artifact.wordsTarget,
        shots: artifact.shotsTarget,
        animations: artifact.animationTarget,
        voice: artifact.voice,
      };
    case "script": {
      const animated = (artifact.shots ?? []).filter((s) => s.animated).length;
      return { shots: artifact.shots?.length ?? 0, words: artifact.stats?.words ?? 0, animated };
    }
    case "image_prompts":
      return { prompts: artifact.prompts?.length ?? 0 };
    case "video_prompts":
      return { prompts: artifact.prompts?.length ?? 0 };
    default:
      return null;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    // ── API ──────────────────────────────────────────────────────────────────
    if (path === "/api/state") {
      adoptProjectsFromDisk(db, PROJECTS);
      return json(res, {
        providers: providersAvailable(env),
        voices: VOICES,
        projects: listProjects(db),
        queue: queueDepth(db),
      });
    }

    if (path === "/api/projects" && req.method === "POST") {
      const body = await readBody(req);
      const title = String(body.title ?? "").trim();
      if (!title) return json(res, { error: "нужен заголовок" }, 400);
      const id = title
        .toLowerCase()
        .replace(/[^a-zа-я0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || `video-${Date.now()}`;
      if (getProject(db, id)) return json(res, { error: "проект с таким именем уже есть" }, 409);
      const project = createProject(db, {
        id,
        title,
        minutes: Number(body.minutes) || 8,
        language: body.language === "en" ? "en" : "ru",
      });
      return json(res, { project });
    }

    const stateMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (stateMatch && req.method === "GET") {
      const state = projectState(decodeURIComponent(stateMatch[1]));
      return state ? json(res, state) : json(res, { error: "проект не найден" }, 404);
    }

    // Поставить стадию в очередь: работу выполняет воркер, сервер не блокируется.
    const runMatch = path.match(/^\/api\/projects\/([^/]+)\/run$/);
    if (runMatch && req.method === "POST") {
      const id = decodeURIComponent(runMatch[1]);
      if (!getProject(db, id)) return json(res, { error: "проект не найден" }, 404);
      const body = await readBody(req);
      const stages = Array.isArray(body.stages) && body.stages.length ? body.stages : STAGES;
      for (const stage of stages) if (STAGES.includes(stage)) enqueue(db, id, stage);
      return json(res, { queued: stages, depth: queueDepth(db) });
    }

    /* Правка одного кадра моделью. Студия показывает все кадры, но поправить в них
       реплику было нечем: оставалось гнать стадию сценария целиком — сорок минут и
       квота. Правка пишет script.json и честно помечает, что теперь устарело. */
    const rewriteMatch = path.match(/^\/api\/projects\/([^/]+)\/shots\/(\d+)\/rewrite$/);
    if (rewriteMatch && req.method === "POST") {
      const id = decodeURIComponent(rewriteMatch[1]);
      const n = Number(rewriteMatch[2]);
      if (!getProject(db, id)) return json(res, { error: "проект не найден" }, 404);

      const script = stageArtifact(id, "script");
      const index = (script?.shots ?? []).findIndex((shot) => shot.n === n);
      if (index < 0) return json(res, { error: "кадр не найден" }, 404);

      const body = await readBody(req);
      const field = body.field === "onScreen" ? "onScreen" : "narration";
      const task = rewriteTask(script.shots[index], {
        instruction: String(body.instruction ?? "").trim(),
        style: stageArtifact(id, "style")?.styleBlock ?? "",
        field,
      });

      let answer;
      try {
        answer = await askJson({ env, ...task });
      } catch (err) {
        return json(res, { error: `модель не ответила: ${err.message}` }, 502);
      }

      const { shot: next, changed, rejected } = applyRewrite(script.shots[index], answer, { field });
      if (!changed) return json(res, { changed: false, rejected, shot: script.shots[index] });

      script.shots[index] = next;
      writeScript(join(PROJECTS, id), script);
      /* Промты, озвучка и монтаж считались от старого текста: показываем это, а не
         оставляем «готово» на стадии, которая уже не соответствует сценарию. */
      const stale = staleStages(true);
      for (const stage of stale) markStage(db, id, stage, "pending");

      return json(res, { changed: true, rejected, shot: next, stale });
    }

    // Панели рисуются кодом и отдаются браузеру как SVG — это бесплатный слой.
    const panelMatch = path.match(/^\/api\/projects\/([^/]+)\/panel\/(\d+)$/);
    if (panelMatch) {
      const id = decodeURIComponent(panelMatch[1]);
      const n = Number(panelMatch[2]);
      const script = stageArtifact(id, "script");
      const shot = (script?.shots ?? []).find((s) => s.n === n);
      if (!shot) return json(res, { error: "кадр не найден" }, 404);
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
      return res.end(panelSvg(shot));
    }

    // Файлы проекта (готовое видео, субтитры, звук) — отдаём как есть.
    const fileMatch = path.match(/^\/files\/(.+)$/);
    if (fileMatch) {
      const rel = decodeURIComponent(fileMatch[1]);
      const full = resolve(join(PROJECTS, rel));
      if (!full.startsWith(resolve(PROJECTS)) || !existsSync(full)) {
        return json(res, { error: "файл не найден" }, 404);
      }
      const data = await readFile(full);
      res.writeHead(200, {
        "Content-Type": MIME[extname(full)] ?? "application/octet-stream",
        "Content-Length": data.length,
      });
      return res.end(data);
    }

    if (path.startsWith("/api/")) return json(res, { error: "неизвестный запрос" }, 404);

    // ── Интерфейс ────────────────────────────────────────────────────────────
    const file = path === "/" ? join(UI, "index.html") : join(UI, path.replace(/^\//, ""));
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("не найдено");
    }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    return res.end(data);
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`kadr: http://127.0.0.1:${PORT}`);
  console.log("провайдеры:", JSON.stringify(providersAvailable(env)));
});
