import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { panelSize } from "../src/assemble.js";
import { FRAME, PANEL } from "../src/providers/image.js";

/**
 * Размер картинки нужен сборке, чтобы понять: широкий кадр заполняет кадр
 * целиком, а квадратный приходится добивать полем. Ошибка здесь стоит либо
 * белых столбов по бокам (лишнее поле), либо обрезанной картинки (лишний срез).
 */

function pngFixture(width, height) {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  Buffer.from("IHDR", "ascii").copy(head, 12);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function jpegFixture(width, height) {
  const head = Buffer.alloc(21);
  head[0] = 0xff;
  head[1] = 0xd8; // начало картинки
  head[2] = 0xff;
  head[3] = 0xc0; // кадр
  head.writeUInt16BE(0x0011, 4); // длина блока
  head[6] = 8; // точность
  head.writeUInt16BE(height, 7);
  head.writeUInt16BE(width, 9);
  head[11] = 3; // число каналов
  head[12] = 0xff;
  head[13] = 0xd9; // конец картинки
  return head;
}

function writeFixture(name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), "kadr-frame-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

test("размер картинки читается по первым байтам, и у JPEG, и у PNG", () => {
  assert.deepEqual(panelSize(writeFixture("w.jpg", jpegFixture(1344, 768))), [1344, 768]);
  assert.deepEqual(panelSize(writeFixture("w.png", pngFixture(1344, 768))), [1344, 768]);
  assert.deepEqual(panelSize(writeFixture("s.jpg", jpegFixture(1024, 1024))), [1024, 1024]);
});

test("нечитаемый файл не роняет сборку: размер просто неизвестен", () => {
  assert.equal(panelSize(writeFixture("broken.jpg", Buffer.from("не картинка"))), null);
});

test("картинку просят широкой — точного 16:9 у модели не существует", () => {
  // Списки разрешённых размеров у NVIDIA: ширина 768…1344, высота 768…960.
  // Точной пары 16:9 среди них нет, ближайшая — 1344×768 (это 7:4).
  const widths = [768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344];
  const heights = [768, 832, 896, 960];
  const exact = widths.some((w) => heights.some((h) => w / h === 16 / 9));
  assert.equal(exact, false, "если сервер разрешил точное 16:9 — бери его вместо 7:4");

  assert.equal(FRAME.width, 1344, "ширина — предел разрешённого");
  assert.equal(FRAME.height, 768);
  assert.ok(Math.abs(FRAME.width / FRAME.height - 16 / 9) < 0.035, "и не дальше допуска сборки");
  assert.equal(FRAME.width % 16, 0, "ширина кратна 16 — иначе кодировщик обрежет");
  assert.equal(FRAME.height % 16, 0, "высота кратна 16 — иначе кодировщик обрежет");
  assert.ok(FRAME.width >= PANEL.width / 2, "картинка не должна быть вдвое мельче кадра");
});
