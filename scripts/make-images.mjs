/**
 * Рисует картинки для кадров проекта.
 *
 * Полезно, когда сценарий уже готов, а картинок нет: команда проходит по всем
 * кадрам и пытается получить изображение — сначала из инбокса (`images/`), потом
 * у внешнего провайдера. Всё, что не вышло, остаётся за рисовальщиком кодом, и об
 * этом печатается честный отчёт с причиной.
 *
 *   node scripts/make-images.mjs --project ponchik
 *   node scripts/make-images.mjs --project ponchik --provider nvidia
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { loadEnv } from "../src/providers/llm.js";
import { collectPanels, inboxReport } from "../src/providers/image.js";

const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const projectId = value("project");
if (!projectId) {
  console.error("нужно имя проекта: --project ponchik");
  process.exit(1);
}
const provider = value("provider", "auto");

const root = "/home/ibrohim/kadr/projects";
const projectDir = join(root, projectId);
const read = (name) => JSON.parse(readFileSync(join(projectDir, `${name}.json`), "utf8"));

if (!existsSync(join(projectDir, "script.json"))) {
  console.error(`в проекте ${projectId} нет сценария — сначала пройди стадию script`);
  process.exit(1);
}

const script = read("script");
const prompts = existsSync(join(projectDir, "image_prompts.json")) ? read("image_prompts").prompts : [];

const before = inboxReport({ projectDir, shots: script.shots });
console.log(`кадров ${script.shots.length}, уже с картинками из инбокса: ${before.ready}`);

const result = await collectPanels({
  projectDir,
  shots: script.shots,
  prompts,
  env: loadEnv(),
  provider,
  log: (line) => console.log(line),
});

console.log(`\nитог: картинок ${result.rendered.size} из ${script.shots.length}, источник — ${result.provider}`);
if (result.drawn.length) console.log(`нарисовал нейросетью: ${result.drawn.length} (${result.drawn.slice(0, 8).join(", ")}…)`);
if (result.failed.length) {
  console.log(`не вышло: ${result.failed.length}`);
  for (const item of result.failed.slice(0, 3)) console.log(`  кадр ${item.shot}: ${item.reason}`);
}
if (result.provider === "none" || result.provider === "inbox") {
  console.log("\nбез нейросетей кадры всё равно будут: сборка нарисует их кодом (render.js).");
  console.log("чтобы пошли настоящие картинки, положи их в " + join(projectDir, "images") + " как 1.png, 2.png…");
}
