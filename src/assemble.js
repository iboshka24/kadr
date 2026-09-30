/**
 * Сборка видео.
 *
 * На входе — панели, озвучка и тайминги слов; на выходе — готовый mp4. Всё
 * считается на этой машине ffmpeg-ом, никаких сервисов.
 *
 * Движение здесь то же, что обещано в промтах анимации: камера стоит, картинка
 * едва дышит. Поэтому у обычных кадров — очень медленный наезд, у кадров с
 * флагом анимации — чуть заметнее, и только. Никаких переходов и зуми в стиле
 * слайд-шоу: эталон ниши — почти статичные рисунки, а не «оживший мультик».
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { panelSvg } from "./providers/render.js";
import { buildAss, toSrt } from "./subtitles.js";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

function ffmpeg(args, { quiet = true } = {}) {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", quiet ? "error" : "info", "-y", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
  });
}

/** Панель кадра: из кэша, а если картинки нет — рисуем сами, чтобы сборка не падала. */
function panelPathFor({ shot, panelsDir, rendered }) {
  const fromProvider = rendered?.get(shot.n);
  if (fromProvider && existsSync(fromProvider)) return fromProvider;
  const own = join(panelsDir, `panel-${String(shot.n).padStart(4, "0")}.png`);
  if (existsSync(own)) return own;
  const svgPath = join(panelsDir, `panel-${String(shot.n).padStart(4, "0")}.svg`);
  writeFileSync(svgPath, panelSvg(shot), "utf8");
  execFileSync("rsvg-convert", ["-w", String(WIDTH), "-h", String(HEIGHT), "-o", own, svgPath]);
  return own;
}

/**
 * Один кадр → клип нужной длины с медленным движением.
 * @param {number} seconds  сколько секунд держится кадр
 * @param {boolean} lively  кадр с флагом анимации — движение чуть заметнее
 */
function buildClip({ panel, seconds, lively, out }) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  // Наезд линейный и очень пологий: 1.00 → 1.045 за кадр. Больше — и рисунок
  // начинает «плыть», что для рисованной от руки картинки выглядит браком.
  const zoomTo = lively ? 1.085 : 1.045;
  const step = (zoomTo - 1) / frames;
  const filter = [
    // Вписываем, а не растягиваем: картинка от нейросети приходит квадратной
    // (1024×1024), и растягивание в 16:9 превратило бы человечка в приплюснутого.
    // Лишнее поле закрашиваем цветом бумаги — он совпадает с фоном панелей.
    `scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${WIDTH * 2}:${HEIGHT * 2}:(ow-iw)/2:(oh-ih)/2:color=0xFFFFFF`,
    `zoompan=z='min(zoom+${step.toFixed(6)},${zoomTo})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    "format=yuv420p",
  ].join(",");

  ffmpeg([
    "-loop", "1", "-i", panel,
    "-t", seconds.toFixed(3),
    "-vf", filter,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

/**
 * Собирает фильм.
 * @param {object} options
 * @param {Array} options.shots кадры с startMs/endMs из alignShots
 * @param {string} options.voicePath mp3 с озвучкой
 * @param {Array} options.words тайминги слов
 * @param {string} options.outDir куда складывать
 * @param {Map<number,string>} [options.rendered] готовые картинки от нейросети
 */
export function assemble({
  shots,
  voicePath,
  words,
  outDir,
  rendered = null,
  subtitles = true,
  assOptions = {},
}) {
  mkdirSync(outDir, { recursive: true });
  const clipsDir = join(outDir, "clips");
  mkdirSync(clipsDir, { recursive: true });
  const panelsDir = join(outDir, "panels");
  mkdirSync(panelsDir, { recursive: true });

  const usable = shots.filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs);
  if (!usable.length) throw new Error("нет кадров с корректными таймингами — сначала озвучка");

  const clips = [];
  // Предел на длину клипа: кадр длиннее полуминуты — это не режиссура, а сбитый
  // тайминг (однажды так рисовался один кадр на двадцать минут в 4K). Лучше
  // обрезать реплику, чем получить неверный фильм ценой получаса ожидания.
  const MAX_CLIP_SECONDS = 30;
  let clamped = 0;
  for (const shot of usable) {
    const raw = (shot.endMs - shot.startMs) / 1000;
    const seconds = Math.max(0.6, Math.min(raw, MAX_CLIP_SECONDS));
    if (raw > MAX_CLIP_SECONDS) clamped += 1;
    const panel = panelPathFor({ shot, panelsDir, rendered });
    const out = join(clipsDir, `clip-${String(shot.n).padStart(4, "0")}.mp4`);
    clips.push(buildClip({ panel, seconds, lively: Boolean(shot.animated), out }));
  }
  if (clamped) console.log(`  сборка: у ${clamped} кадров тайминг был сбит и обрезан до ${MAX_CLIP_SECONDS} с`);

  const listFile = join(clipsDir, "list.txt");
  writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n"), "utf8");

  const silent = join(outDir, "video-silent.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", silent]);

  // srt кладём рядом: некоторые площадки просят отдельный файл субтитров.
  const srtPath = join(outDir, "subtitles.srt");
  writeFileSync(srtPath, toSrt(words), "utf8");

  // А в картинку прожигаем ASS с подсветкой произносимого слова.
  const assPath = join(outDir, "subtitles.ass");
  writeFileSync(assPath, buildAss(words, assOptions), "utf8");

  const final = join(outDir, "video.mp4");
  const args = ["-i", silent, "-i", voicePath];

  // Субтитры прожигаем только если есть тайминги слов. С пустым списком .srt
  // получается пустым файлом, и ffmpeg отказывается его открывать — сборка
  // падала на ровном месте при монтаже без озвученных слов.
  const burnSubtitles = Boolean(subtitles) && Array.isArray(words) && words.length > 0;

  if (burnSubtitles) {
    // Прожигаем субтитры в картинку: так ролик одинаково выглядит везде, где его
    // зальют, и не зависит от того, подхватит ли площадка отдельный файл. Вид,
    // размер и подсветка заданы в самом ASS — force_style здесь не нужен.
    args.push("-vf", `subtitles=${assPath}`);
  }

  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", final,
  );
  ffmpeg(args);

  const durationMs = usable[usable.length - 1].endMs;
  return {
    video: final,
    silent,
    clips,
    subtitles: srtPath,
    ass: assPath,
    durationMs,
    seconds: Math.round(durationMs / 100) / 10,
    clipsCount: clips.length,
  };
}

/** Сколько всё это весит и как долго — для отчёта, а не для догадок. */
export function describeFilm(result) {
  const size = existsSync(result.video) ? readFileSync(result.video).length : 0;
  return {
    ...result,
    bytes: size,
    megabytes: Math.round((size / 1024 / 1024) * 10) / 10,
  };
}
