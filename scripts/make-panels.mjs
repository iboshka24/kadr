
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { panelSvg } from "../src/providers/render.js";

const OUT = "/home/ibrohim/.kadr-probe/panels";
mkdirSync(OUT, { recursive: true });

const shots = [
  { n: 1, onScreen: "человек за столом с пончиком и чашкой кофе" },
  { n: 2, onScreen: "фабрика, конвейер, рабочий показывает рукой" },
  { n: 3, onScreen: "монеты, банкноты, вопрос цены" },
  { n: 4, onScreen: "график продаж растёт" },
  { n: 5, onScreen: "телефон в руке, лента уведомлений" },
  { n: 6, onScreen: "толпа людей в городе" },
  { n: 7, onScreen: "учёный в лаборатории у стола" },
  { n: 8, onScreen: "часы, ожидание в очереди" },
];

for (const shot of shots) {
  const svg = panelSvg(shot);
  const svgPath = `${OUT}/panel-${shot.n}.svg`;
  const pngPath = `${OUT}/panel-${shot.n}.png`;
  writeFileSync(svgPath, svg, "utf8");
  execFileSync("rsvg-convert", ["-w", "640", "-h", "360", "-o", pngPath, svgPath]);
  console.log(`кадр ${shot.n}: svg ${svg.length} байт -> png ok`);
}
console.log("готово:", OUT);
