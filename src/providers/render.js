/**
 * Рисование панелей кодом.
 *
 * Зачем свой рисовальщик, когда есть нейросети: у бесплатных квот есть дно, и
 * когда оно наступает, конвейер не должен вставать. Этот путь не тратит ничего
 * и не зависит от чужих серверов — а кадр всё равно остаётся нарисованным от
 * руки, потому что линия здесь дрожит: каждая черта — не отрезок, а кривая с
 * детерминированным смещением. Один и тот же кадр всегда рисуется одинаково
 * (смещение считается от номера кадра), поэтому панели кэшируются, а сборка
 * повторяема.
 *
 * Текста внутри картинки нет: слова живут в озвучке и субтитрах, а не в рисунке.
 */

const W = 1920;
const H = 1080;

/** Палитра канала: несколько плоских цветов, как в эталонных кадрах. */
export const PALETTE = {
  ink: "#1c1a17",
  paper: "#ffffff",
  red: "#e0453b",
  yellow: "#f2c14e",
  blue: "#5aa9e6",
  green: "#6aa84f",
  brown: "#b0713c",
  gray: "#c9c4bb",
};

/** Детерминированный генератор: одна панель — одна последовательность дрожи. */
function rng(seed) {
  let state = (seed * 2654435761) % 4294967296 || 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const n = (v) => Math.round(v * 10) / 10;

/** Дрожащая линия: ломаная из мелких точек вместо идеального отрезка. */
function wobbleLine(r, x1, y1, x2, y2, amp = 2.6) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.round(len / 34));
  const nx = -dy / (len || 1);
  const ny = dx / (len || 1);
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const off = i === 0 || i === steps ? (r() - 0.5) * amp * 0.5 : (r() - 0.5) * amp * 2;
    pts.push([x1 + dx * t + nx * off, y1 + dy * t + ny * off]);
  }
  return "M" + pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(" L");
}

/** Дрожащий прямоугольник: контур и, если нужен, плоская заливка. */
function wobbleRect(r, x, y, w, h, { fill = "none" } = {}) {
  return (
    `<path d="${wobbleLine(r, x, y, x + w, y)} ${wobbleLine(r, x + w, y, x + w, y + h)} ` +
    `${wobbleLine(r, x + w, y + h, x, y + h)} ${wobbleLine(r, x, y + h, x, y)} Z" ` +
    `fill="${fill}" stroke="${PALETTE.ink}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />`
  );
}

function wobbleCircle(r, cx, cy, rad, { fill = PALETTE.paper, amp = 2.2 } = {}) {
  const steps = Math.max(8, Math.round(rad / 2.2));
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const rr = rad + (r() - 0.5) * amp;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return (
    `<path d="${"M" + pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(" L")} Z" ` +
    `fill="${fill}" stroke="${PALETTE.ink}" stroke-width="6" stroke-linejoin="round" />`
  );
}

/**
 * Человечек.
 *
 * Тело — палки, голова — круг, никакой мимики: в кадре должно читаться
 * действие, а не лицо. Поза задаётся углами, поэтому новые позы не требуют
 * новой отрисовки.
 */
export const POSES = {
  stand: { armA: 80, armB: 10, legA: 6, legB: -4 },
  walk: { armA: 120, armB: 25, legA: 26, legB: -30 },
  sit: { armA: 100, armB: 35, legA: 88, legB: -10, hipDrop: 46 },
  point: { armA: 168, armB: 4, legA: 8, legB: -6 },
  raise: { armA: 200, armB: 8, legA: 4, legB: -4 },
  run: { armA: 150, armB: 40, legA: 44, legB: -48 },
  shrug: { armA: 150, armB: 60, legA: 6, legB: -4 },
};

/**
 * @param {object} options
 * @param {string} options.pose ключ из POSES
 * @param {number} options.x точка опоры (ноги)
 * @param {number} options.y уровень пола под фигурой
 * @param {number} options.scale 1 — рост около 320 пикселей
 * @param {string} options.color цвет корпуса
 * @param {boolean} options.flip смотреть влево
 */
function figure(r, { pose = "stand", x, y, scale = 1, color = PALETTE.yellow, flip = false } = {}) {
  const p = POSES[pose] ?? POSES.stand;
  const s = scale;
  const hipY = y - 150 * s - (p.hipDrop ?? 0) * s;
  const shoulderY = hipY - 110 * s;
  const headY = shoulderY - 34 * s;
  const dir = flip ? -1 : 1;
  const rad = (deg) => (deg * Math.PI) / 180;

  const limb = (ox, oy, a, len1, a2, len2) => {
    const x1 = ox + Math.cos(rad(a)) * len1 * dir * -1;
    const y1 = oy + Math.sin(rad(a)) * len1;
    const x2 = x1 + Math.cos(rad(a2)) * len2 * dir * -1;
    const y2 = y1 + Math.sin(rad(a2)) * len2;
    return { d: `${wobbleLine(r, ox, oy, x1, y1)} ${wobbleLine(r, x1, y1, x2, y2)}`, end: [x2, y2] };
  };

  const arm = limb(x, shoulderY, p.armA, 78 * s, p.armA + p.armB - 90, 72 * s);
  const leg = limb(x, hipY, 90 + p.legA, 82 * s, 90 + p.legA + p.legB, 82 * s);

  return (
    "<g>" +
    wobbleCircle(r, x, headY, 30 * s, { fill: PALETTE.paper }) +
    wobbleLine(r, x, shoulderY, x, hipY, 2.2) +
    `<path d="${arm.d}" fill="none" stroke="${PALETTE.ink}" stroke-width="7" stroke-linecap="round" />` +
    `<path d="${leg.d}" fill="none" stroke="${PALETTE.ink}" stroke-width="7" stroke-linecap="round" />` +
    // Корпус — плоское пятно цвета: так фигура читается как нарисованная, а не как проволока.
    `<path d="${wobbleLine(r, x - 26 * s, shoulderY + 10 * s, x + 26 * s, shoulderY + 10 * s)} ` +
    `${wobbleLine(r, x + 26 * s, shoulderY + 10 * s, x + 20 * s, hipY + 6 * s)} ` +
    `${wobbleLine(r, x + 20 * s, hipY + 6 * s, x - 20 * s, hipY + 6 * s)} ` +
    `${wobbleLine(r, x - 20 * s, hipY + 6 * s, x - 26 * s, shoulderY + 10 * s)} Z" ` +
    `fill="${color}" stroke="${PALETTE.ink}" stroke-width="5" stroke-linejoin="round" />` +
    "</g>"
  );
}

/** Предметы. Каждый — маленькая функция от координат. */
export const PROPS = {
  table: (r, x, y, s = 1) =>
    wobbleRect(r, x - 150 * s, y - 20 * s, 300 * s, 20 * s, { fill: PALETTE.brown }) +
    wobbleLine(r, x - 130 * s, y, x - 130 * s, y + 130 * s) +
    wobbleLine(r, x + 130 * s, y, x + 130 * s, y + 130 * s, 2),
  donut: (r, x, y, s = 1) =>
    wobbleCircle(r, x, y, 40 * s, { fill: PALETTE.brown }) +
    wobbleCircle(r, x, y, 14 * s, { fill: PALETTE.paper, amp: 1.6 }),
  cup: (r, x, y, s = 1) => wobbleRect(r, x - 26 * s, y - 56 * s, 52 * s, 56 * s, { fill: PALETTE.paper }),
  phone: (r, x, y, s = 1) => wobbleRect(r, x - 26 * s, y - 88 * s, 52 * s, 88 * s, { fill: PALETTE.blue }),
  coin: (r, x, y, s = 1) =>
    wobbleCircle(r, x, y, 44 * s, { fill: PALETTE.yellow }) +
    wobbleCircle(r, x, y, 26 * s, { fill: "none", amp: 1.4 }),
  note: (r, x, y, s = 1) =>
    wobbleRect(r, x - 84 * s, y - 48 * s, 168 * s, 96 * s, { fill: PALETTE.green }) +
    wobbleCircle(r, x, y, 22 * s, { fill: PALETTE.paper, amp: 1.4 }),
  box: (r, x, y, s = 1, color = PALETTE.brown) => wobbleRect(r, x - 70 * s, y - 90 * s, 140 * s, 90 * s, { fill: color }),
  factory: (r, x, y, s = 1) =>
    wobbleRect(r, x - 190 * s, y - 130 * s, 380 * s, 130 * s, { fill: PALETTE.gray }) +
    wobbleRect(r, x - 120 * s, y - 210 * s, 48 * s, 86 * s, { fill: PALETTE.gray }) +
    wobbleRect(r, x + 60 * s, y - 250 * s, 48 * s, 126 * s, { fill: PALETTE.gray }) +
    wobbleCircle(r, x - 96 * s, y - 250 * s, 26 * s, { fill: PALETTE.paper, amp: 2 }) +
    wobbleCircle(r, x + 84 * s, y - 296 * s, 30 * s, { fill: PALETTE.paper, amp: 2 }),
  clock: (r, x, y, s = 1) =>
    wobbleCircle(r, x, y, 78 * s, { fill: PALETTE.paper }) +
    wobbleLine(r, x, y, x, y - 48 * s, 1.6) +
    wobbleLine(r, x, y, x + 40 * s, y + 12 * s, 1.6),
  arrowUp: (r, x, y, s = 1, color = PALETTE.red) =>
    `<path d="${wobbleLine(r, x, y, x, y - 150 * s)} ${wobbleLine(r, x, y - 150 * s, x - 40 * s, y - 96 * s)} ` +
    `${wobbleLine(r, x, y - 150 * s, x + 40 * s, y - 96 * s)}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" />`,
  chart: (r, x, y, s = 1) =>
    wobbleLine(r, x - 24 * s, y, x + 210 * s, y) +
    wobbleLine(r, x - 24 * s, y, x - 24 * s, y - 230 * s) +
    wobbleRect(r, x, y - 90 * s, 44 * s, 90 * s, { fill: PALETTE.blue }) +
    wobbleRect(r, x + 62 * s, y - 150 * s, 44 * s, 150 * s, { fill: PALETTE.yellow }) +
    wobbleRect(r, x + 124 * s, y - 110 * s, 44 * s, 110 * s, { fill: PALETTE.green }) +
    wobbleRect(r, x + 186 * s, y - 210 * s, 44 * s, 210 * s, { fill: PALETTE.red }),
  building: (r, x, y, s = 1) =>
    wobbleRect(r, x - 90 * s, y - 330 * s, 180 * s, 330 * s, { fill: PALETTE.gray }) +
    wobbleRect(r, x - 52 * s, y - 280 * s, 30 * s, 30 * s, { fill: PALETTE.yellow }) +
    wobbleRect(r, x + 12 * s, y - 280 * s, 30 * s, 30 * s, { fill: PALETTE.yellow }) +
    wobbleRect(r, x - 52 * s, y - 180 * s, 30 * s, 30 * s, { fill: PALETTE.yellow }) +
    wobbleRect(r, x + 12 * s, y - 180 * s, 30 * s, 30 * s, { fill: PALETTE.yellow }),
  scale: (r, x, y, s = 1) =>
    wobbleLine(r, x, y - 200 * s, x, y) +
    wobbleLine(r, x - 120 * s, y - 190 * s, x + 120 * s, y - 190 * s) +
    wobbleLine(r, x - 120 * s, y - 190 * s, x - 120 * s, y - 130 * s) +
    wobbleLine(r, x + 120 * s, y - 190 * s, x + 120 * s, y - 130 * s) +
    wobbleCircle(r, x - 120 * s, y - 100 * s, 34 * s, { fill: PALETTE.yellow }) +
    wobbleCircle(r, x + 120 * s, y - 100 * s, 34 * s, { fill: PALETTE.paper }),
  syringe: (r, x, y, s = 1) =>
    wobbleRect(r, x - 18 * s, y - 120 * s, 36 * s, 110 * s, { fill: PALETTE.paper }) +
    wobbleLine(r, x, y - 10 * s, x, y + 30 * s) +
    wobbleRect(r, x - 30 * s, y - 158 * s, 60 * s, 26 * s, { fill: PALETTE.gray }),
  heart: (r, x, y, s = 1) =>
    wobbleCircle(r, x - 26 * s, y - 20 * s, 34 * s, { fill: PALETTE.red }) +
    wobbleCircle(r, x + 26 * s, y - 20 * s, 34 * s, { fill: PALETTE.red }) +
    `<path d="${wobbleLine(r, x - 56 * s, y - 6 * s, x, y + 66 * s)} ${wobbleLine(r, x, y + 66 * s, x + 56 * s, y - 6 * s)}" ` +
    `fill="none" stroke="${PALETTE.ink}" stroke-width="6" />`,
};


/** Текст в SVG: кавычки и амперсанды в подписях ломают разметку, если их не экранировать. */
export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const RED = "#d92d20";

/**
 * Красная стрелка — фирменный приём канала.
 * Стрелка рисуется дрожащей рукой, как и всё остальное: ровная линия выбивается.
 */
function arrow(r, fromX, fromY, toX, toY, { color = RED, width = 7 } = {}) {
  const shaft = wobbleLine(r, fromX, fromY, toX, toY, 2.2);
  const length = Math.hypot(toX - fromX, toY - fromY) || 1;
  const ux = (toX - fromX) / length;
  const uy = (toY - fromY) / length;
  const px = -uy;
  const py = ux;
  const size = 34;
  const head =
    `M ${(toX - ux * size + px * size * 0.55).toFixed(1)} ${(toY - uy * size + py * size * 0.55).toFixed(1)}` +
    ` L ${toX.toFixed(1)} ${toY.toFixed(1)}` +
    ` L ${(toX - ux * size - px * size * 0.55).toFixed(1)} ${(toY - uy * size - py * size * 0.55).toFixed(1)}`;

  return (
    `<path d="${shaft}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round" />` +
    `<path d="${head}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round" />`
  );
}

/** Жирная чёрная подпись большими буквами — второй элемент того же приёма. */
function caption(text, x, y, { size = 58 } = {}) {
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="${size}" fill="#111111" text-anchor="middle" letter-spacing="1">${escapeXml(String(text).toUpperCase())}</text>`;
}

/** Плашка с датой в углу кадра: выглядит как выписка из документа, держит доверие. */
function dateStamp(text) {
  const label = escapeXml(String(text));
  const width = Math.max(150, 20 + String(text).length * 17);
  return (
    `<rect x="48" y="44" width="${width}" height="52" fill="#111111" rx="4" />` +
    `<text x="${48 + width / 2}" y="79" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="26" fill="#ffffff" text-anchor="middle">${label}</text>`
  );
}

/** Год, месяц с годом или «в 1950-х» — это уже факт-выписка, а не подпись. */
const DATE_LIKE = /\b(1[0-9]{3}|20[0-9]{2})\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(1[89][0-9]{2}|20[0-9]{2})\b/i;

/**
 * Что добавить в кадр из слов на экране.
 *
 * Правило простое: короткая надпись — это подпись со стрелкой (как «CULTURE»),
 * надпись с годом — это плашка-дата в углу (как «Nov 2021»). Один и тот же текст
 * читается по-разному в зависимости от вида, и это ровно то, что делает канал.
 */
export function annotationFor(onScreen) {
  const text = String(onScreen ?? "").trim();
  if (!text) return { mode: "none" };

  if (DATE_LIKE.test(text) && text.length <= 24) return { mode: "date", text };

  const words = text.split(/\s+/).length;
  if (text.length <= 18 && words <= 3) return { mode: "caption", text };
  return { mode: "none" };
}

/**
 * Сцены: что рисовать, если в описании кадра есть такое-то слово.
 * Правило кадра простое — рисуется то, о чём говорит кадр.
 */
const SCENES = [
  { match: /фабрик|завод|производств|конвейер/i, draw: (r) => PROPS.factory(r, 980, 760, 1.25) + figure(r, { pose: "point", x: 430, y: 780, scale: 1.1 }) },
  { match: /деньг|монет|банкнот|цен|дорого|дешев|касс|зарплат/i, draw: (r) => PROPS.coin(r, 1180, 700, 1.2) + PROPS.note(r, 1440, 780, 1) + figure(r, { pose: "shrug", x: 520, y: 790, scale: 1.15 }) },
  { match: /телефон|экран|прилож|лент|скролл|уведомл|смартфон/i, draw: (r) => PROPS.phone(r, 1240, 800, 2.1) + figure(r, { pose: "stand", x: 640, y: 800, scale: 1.15, flip: true }) },
  { match: /час|врем|ожидан|очеред|ждёт|минут/i, draw: (r) => PROPS.clock(r, 1240, 560, 1.7) + figure(r, { pose: "sit", x: 620, y: 810, scale: 1.1 }) },
  { match: /график|рост|паден|прибыл|продаж|статистик|цифр/i, draw: (r) => PROPS.chart(r, 1150, 790, 1.15) + figure(r, { pose: "point", x: 520, y: 800, scale: 1.1 }) },
  { match: /врач|таблет|укол|клиник|болезн|здоров/i, draw: (r) => PROPS.syringe(r, 1300, 720, 1.6) + figure(r, { pose: "stand", x: 620, y: 800, scale: 1.15 }) },
  { match: /сердц|любов|чувств|желани/i, draw: (r) => PROPS.heart(r, 1250, 620, 1.6) + figure(r, { pose: "stand", x: 560, y: 800, scale: 1.15, flip: true }) },
  { match: /город|здани|офис|корпорац|компан/i, draw: (r) => PROPS.building(r, 1300, 800, 1.35) + PROPS.building(r, 1620, 800, 0.95) + figure(r, { pose: "walk", x: 480, y: 800, scale: 1.1 }) },
  { match: /вес|выбор|сравн|решени|между/i, draw: (r) => PROPS.scale(r, 1250, 790, 1.3) + figure(r, { pose: "shrug", x: 520, y: 800, scale: 1.1 }) },
  { match: /стол|обед|ед|пончик|бургер|сахар|калор|пищ|съел/i, draw: (r) => PROPS.table(r, 1080, 700, 1.35) + PROPS.donut(r, 1140, 626, 1.25) + PROPS.cup(r, 1290, 672, 1.1) + figure(r, { pose: "sit", x: 640, y: 800, scale: 1.15 }) },
  { match: /толп|люди|все |общество|городск/i, draw: (r) => ["#f2c14e", "#5aa9e6", "#6aa84f", "#e0453b", "#b0713c"].map((c, i) => figure(r, { pose: "stand", x: 420 + i * 280, y: 800, scale: 0.95, color: c })).join("") },
  { match: /учён|лаборатор|исследован|эксперимент|наук/i, draw: (r) => PROPS.table(r, 1180, 680, 1.2) + PROPS.cup(r, 1220, 610, 1.5) + PROPS.cup(r, 1120, 610, 1.1) + figure(r, { pose: "point", x: 620, y: 800, scale: 1.15 }) },
];

/**
 * Панель к кадру.
 * @param {{n:number,onScreen:string,scene?:string}} shot
 * @returns {string} SVG
 */
export function panelSvg(shot, { seedBase = 17 } = {}) {
  const r = rng((shot.n ?? 1) * 7919 + seedBase);
  const text = String(shot.scene ?? shot.onScreen ?? "");
  const scene = SCENES.find((s) => s.match.test(text));
  const body = scene ? scene.draw(r) : figure(r, { pose: "stand", x: 900, y: 800, scale: 1.5 });
  const floor = wobbleLine(r, 120, 800, 1800, 800, 3.4);

  // Фирменные пометки поверх сцены: подпись со стрелкой или плашка с датой.
  const note = annotationFor(shot.onScreen);
  let marks = "";
  if (note.mode === "caption") {
    marks = caption(note.text, 780, 250) + arrow(r, 800, 300, 830, 600);
  } else if (note.mode === "date") {
    marks = dateStamp(note.text);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="${PALETTE.paper}" />` +
    `<path d="${floor}" stroke="${PALETTE.gray}" stroke-width="4" fill="none" />` +
    body +
    marks +
    "</svg>"
  );
}

export const SCENE_MATCHERS = SCENES.map((s) => s.match.source);
