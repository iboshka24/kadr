/**
 * Воркер: выполняет стадии из очереди.
 *
 * Отдельный процесс, а не работа внутри запроса: сценарий на восемь минут — это
 * несколько обращений к модели подряд, и держать из-за них открытым браузер
 * нельзя. Воркер можно перезапустить, он подхватит то, что осталось в очереди;
 * упавшее задание повторяется, но не бесконечно.
 */
import { join } from "node:path";

import { openDb, claimJob, finishJob, markStage, queueDepth, STAGES } from "./db.js";
import { loadEnv } from "./providers/llm.js";
import { synthesize, alignShots } from "./providers/voice.js";
import { collectPanels } from "./providers/image.js";
import { assemble, describeFilm } from "./assemble.js";
import {
  stageTranscript,
  stageIdeas,
  stageNiche,
  stageStyle,
  stageParams,
  stageScript,
  stageImagePrompts,
  stageVideoPrompts,
} from "./stages/index.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { PROJECTS } from "./paths.js";
const env = loadEnv();
const db = openDb(join(PROJECTS, "kadr.db"));

const artifactPath = (id, name) => join(PROJECTS, id, `${name}.json`);
const readArtifact = (id, name) => {
  const file = artifactPath(id, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};
const writeArtifact = (id, name, data) => {
  mkdirSync(join(PROJECTS, id), { recursive: true });
  writeFileSync(artifactPath(id, name), JSON.stringify(data, null, 2), "utf8");
};

/** Что нужно стадии на входе: она берёт это из уже посчитанных материалов. */
function contextFor(projectId) {
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
  return {
    project,
    style: readArtifact(projectId, "style"),
    params: readArtifact(projectId, "params"),
    concept: readArtifact(projectId, "concept"),
    ideas: readArtifact(projectId, "ideas"),
    script: readArtifact(projectId, "script"),
    imagePrompts: readArtifact(projectId, "image_prompts"),
    transcript: readArtifact(projectId, "transcript"),
    analysis: readArtifact(projectId, "analysis"),
  };
}

/**
 * Выполняет одну стадию.
 * Стадии озвучки и сборки живут здесь же, хотя и не требуют модели: для
 * сценариста это такие же шаги конвейера, и в очереди они выглядят одинаково.
 */
async function runStage(projectId, stage) {
  const ctx = contextFor(projectId);
  if (!ctx.project) throw new Error("проект не найден");

  switch (stage) {
    case "transcript": {
      if (!env.KADR_TRANSCRIPT_PATH || !existsSync(env.KADR_TRANSCRIPT_PATH)) {
        throw new Error("нужен файл транскрипта: положи его путь в KADR_TRANSCRIPT_PATH");
      }
      const transcript = readFileSync(env.KADR_TRANSCRIPT_PATH, "utf8");
      const result = await stageTranscript({ transcript, env });
      writeArtifact(projectId, "transcript", { transcript });
      writeArtifact(projectId, "analysis", result.output);
      return result;
    }
    case "ideas": {
      // Тема приходит либо из проекта, либо из окружения: на входе может быть
      // просто тема, а идеи придумывает модель.
      const topic = ctx.project.topic || env.KADR_TOPIC;
      if (!topic) throw new Error("нет темы: положи её в поле topic проекта или в KADR_TOPIC");
      const result = await stageIdeas({ topic, env });
      writeArtifact(projectId, "ideas", result.output);
      return result;
    }
    case "niche": {
      if (!ctx.analysis) throw new Error("сначала разбор транскрипта");
      const chosen = ctx.ideas?.ideas?.[0];
      const idea = ctx.project.niche ? JSON.parse(ctx.project.niche) : chosen ?? ctx.analysis?.ideas?.[0];
      if (!idea) throw new Error("в разборе нет ни одной идеи");
      const result = await stageNiche({ idea, analysis: ctx.analysis, env });
      writeArtifact(projectId, "concept", result.output);
      return result;
    }
    case "style": {
      const notes = env.KADR_REFERENCE_NOTES || `Язык канала снят с присланных кадров. Мультяшная рисованная графика двух видов фона:
чистый белый лист и плоская ночная синева.

Человек нарисован палочками: круглая голова, точки-глаза, линия рта, простые палочки-руки и ноги.
Лица живые, поза выразительная, часто нелепая. Никакого фотореализма и никаких детальных лиц.

Подписи — фирменный приём канала. Красная стрелка указывает на предмет, рядом жирная чёрная
надпись большими буквами прямо в кадре (как «CULTURE» над младенцем у костра). Стрелка и подпись
входят в картинку, а не добавляются потом.

Даты и числа — отдельной плашкой в углу кадра (как «Nov 2021»), будто выписка из документа:
она подтверждает факт и держит доверие.

Отдельный вид кадра — натюрморт из предметов сцены без людей: микрофон на стойке, гитара,
прислонённая к табурету с губной гармошкой, пластинка в рамке на стене.

Жирный чёрный контур, плоские заливки без градиентов и теней. Для ночных сцен — тёмно-синее небо,
звёзды, силуэты гор, костёр в центре. Много пустого места, один сюжет на кадр.`;
      const result = await stageStyle({ referenceNotes: notes, env, language: ctx.project.language });
      writeArtifact(projectId, "style", result.output);
      return result;
    }
    case "params": {
      const result = await stageParams({ minutes: ctx.project.minutes, language: ctx.project.language });
      writeArtifact(projectId, "params", result.output);
      return result;
    }
    case "script": {
      if (!ctx.concept || !ctx.params || !ctx.style) throw new Error("нужны замысел, параметры и паспорт стиля");
      const result = await stageScript({ concept: ctx.concept, params: ctx.params, style: ctx.style, env });
      writeArtifact(projectId, "script", result.output);
      return result;
    }
    case "image_prompts": {
      if (!ctx.script || !ctx.style) throw new Error("нужен сценарий и паспорт стиля");
      const result = await stageImagePrompts({ shots: ctx.script.shots, style: ctx.style, env, projectDir: join(PROJECTS, projectId) });
      writeArtifact(projectId, "image_prompts", result.output);
      return result;
    }
    case "video_prompts": {
      if (!ctx.script || !ctx.style) throw new Error("нужен сценарий и паспорт стиля");
      const result = await stageVideoPrompts({
        shots: ctx.script.shots,
        style: ctx.style,
        imagePrompts: ctx.imagePrompts?.prompts ?? [],
        env,
      });
      writeArtifact(projectId, "video_prompts", result.output);
      return result;
    }
    case "voice": {
      if (!ctx.script) throw new Error("нужен сценарий");
      const voice = ctx.params?.voice ?? "ru-RU-DmitryNeural";
      const narration = ctx.script.shots.map((s) => s.narration).join(" ");
      const result = await synthesize({ text: narration, outDir: join(PROJECTS, projectId, "voice"), voice });
      const timed = alignShots(ctx.script.shots, result.words);
      writeArtifact(projectId, "timed_shots", timed);
      writeArtifact(projectId, "voice", { audio: result.audio, words: result.words.length, durationMs: result.durationMs });
      return { output: { words: result.words.length, durationMs: result.durationMs }, errors: [], warnings: [] };
    }
    case "assemble": {
      const timed = readArtifact(projectId, "timed_shots");
      const voice = readArtifact(projectId, "voice");
      if (!timed || !voice) throw new Error("сначала озвучка");

      // Картинки: инбокс руками → внешний провайдер → рисовальщик кодом.
      const panels = await collectPanels({
        projectDir: join(PROJECTS, projectId),
        shots: timed,
        prompts: ctx.imagePrompts?.prompts ?? [],
        env,
        log: (line) => console.log(`  ${line}`),
      });

      const film = describeFilm(
        assemble({
          shots: timed,
          voicePath: voice.audio,
          words: [],
          outDir: join(PROJECTS, projectId, "video"),
          rendered: panels.rendered,
        }),
      );
      writeArtifact(projectId, "panels", {
        provider: panels.provider,
        ready: panels.rendered.size,
        drawnByNetwork: panels.drawn.length,
        failed: panels.failed,
        reasons: panels.reasons,
      });
      writeArtifact(projectId, "film", film);
      return { output: film, errors: [], warnings: [] };
    }
    default:
      throw new Error(`неизвестная стадия: ${stage}`);
  }
}

async function loopOnce() {
  const job = claimJob(db);
  if (!job) return false;

  const { id, project_id: projectId, stage, attempts, max_attempts: maxAttempts } = job;
  console.log(`[${new Date().toISOString()}] стадия ${stage} проекта ${projectId} (попытка ${attempts})`);
  markStage(db, projectId, stage, "running");

  try {
    const result = await runStage(projectId, stage);
    markStage(db, projectId, stage, "done", { output: { stats: result.stats, warnings: result.warnings } });
    if (result.errors?.length) {
      console.log(`  замечания: ${result.errors.slice(0, 3).join("; ")}`);
    }
    finishJob(db, id, "done");
    console.log(`  готово`);
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 500);
    markStage(db, projectId, stage, "failed", { error: message });
    const willRetry = attempts < maxAttempts;
    finishJob(db, id, willRetry ? "queued" : "failed", message);
    console.log(`  ошибка: ${message}${willRetry ? " — повторю" : ""}`);
  }
  return true;
}

const once = process.argv.includes("--once");
if (once) {
  const worked = await loopOnce();
  console.log(worked ? "одно задание выполнено" : "очередь пуста");
} else {
  console.log(`воркер запущен, в очереди ${queueDepth(db)}`);
  for (;;) {
    const worked = await loopOnce();
    if (!worked) await new Promise((r) => setTimeout(r, 2000));
  }
}
