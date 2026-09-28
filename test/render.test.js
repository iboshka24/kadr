import { test } from "node:test";
import assert from "node:assert/strict";
import { panelSvg, annotationFor, escapeXml } from "../src/providers/render.js";

test("короткая надпись становится подписью со стрелкой", () => {
  const svg = panelSvg({ n: 3, onScreen: "CULTURE", scene: "у костра" });
  assert.match(svg, /CULTURE/);
  assert.match(svg, /#d92d20/, "стрелка должна быть красной");
});

test("надпись с годом становится плашкой с датой", () => {
  const svg = panelSvg({ n: 4, onScreen: "Nov 2021", scene: "в комнате" });
  assert.match(svg, /Nov 2021/);
  assert.match(svg, /<rect x="48" y="44"/, "плашка стоит в углу кадра");
  assert.doesNotMatch(svg, /#d92d20/, "у плашки стрелки нет");
});

test("длинная надпись не превращается ни в то, ни в другое", () => {
  assert.equal(annotationFor("люди приходят и уходят каждый день").mode, "none");
  assert.equal(annotationFor("").mode, "none");
});

test("подписи экранируются, кавычки не ломают разметку", () => {
  assert.equal(escapeXml('a "b" & <c>'), "a &quot;b&quot; &amp; &lt;c&gt;");
  const svg = panelSvg({ n: 5, onScreen: 'A "B"', scene: "сцена" });
  assert.doesNotMatch(svg, /A "B"/);
});