/**
 * Интерфейс сценариста.
 *
 * Держит на экране то, по чему принимают решения: состояние стадий, кадры с
 * нарисованными панелями, промты (их копируют руками, если генерировать
 * картинки пока нечем) и готовый файл. Ничего не выдумывает: все цифры приходят
 * с сервера.
 */
const $ = (sel) => document.querySelector(sel);

const STAGE_NAMES = {
  transcript: "разбор референса",
  ideas: "идеи",
  niche: "замысел",
  style: "паспорт стиля",
  params: "параметры",
  script: "сценарий",
  image_prompts: "промты картинок",
  video_prompts: "промты анимаций",
  voice: "озвучка",
  assemble: "сборка",
};

let current = null;
let state = null;

const api = async (url, options) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ошибка ${res.status}`);
  return data;
};

/** Общий список: провайдеры, проекты, очередь. */
async function loadCommon() {
  const data = await api("/api/state");
  state = data;

  $("#providers").innerHTML = Object.entries(data.providers)
    .map(([name, on]) => `<span class="chip ${on ? "on" : "off"}">${name}${on ? "" : " — нет ключа"}</span>`)
    .join("");
  $("#queue").textContent = data.queue ? `в очереди: ${data.queue}` : "очередь пуста";

  $("#projects").innerHTML = data.projects.length
    ? data.projects
        .map(
          (p) =>
            `<li><button data-id="${p.id}" class="${p.id === current ? "on" : ""}">` +
            `<span>${escapeHtml(p.title)}</span><small>${p.minutes} мин</small></button></li>`,
        )
        .join("")
    : "<li><small>пока нет ни одного</small></li>";
}

async function openProject(id) {
  current = id;
  $("#empty").hidden = true;
  $("#view").hidden = false;
  await refresh();
}

/** Полное состояние проекта: стадии, кадры, промты, файл. */
async function refresh() {
  const data = await api(`/api/projects/${encodeURIComponent(current)}`);
  $("#title").textContent = data.project.title;
  $("#sub").textContent =
    `${data.project.minutes} мин · ${data.project.language} · кадров ${data.shots.length} · ` +
    `промтов ${data.prompts.length} · анимаций ${data.videoPrompts.length}`;

  $("#stages").innerHTML = data.stages
    .map(
      (s, i) =>
        `<li class="${s.status}" data-stage="${s.stage}" title="${s.error ? escapeHtml(s.error) : "нажми, чтобы запустить"}">` +
        `<span class="n">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="name">${STAGE_NAMES[s.stage] ?? s.stage}</span>` +
        `<span class="state">${stateOf(s)}</span></li>`,
    )
    .join("");

  const film = data.film;
  const link = $("#film");
  if (film?.video) {
    link.hidden = false;
    link.href = `/files/${film.video.replace("/home/ibrohim/kadr/projects/", "")}`;
    link.textContent = `Скачать видео (${film.megabytes} МБ)`;
  } else {
    link.hidden = true;
  }

  renderShots(data);
  await loadCommon();
}

function stateOf(s) {
  if (s.status === "running") return "идёт…";
  if (s.status === "failed") return "ошибка";
  if (s.status === "done") return "готово";
  return s.ready ? "готово" : "не начато";
}

/** Кадр: панель, реплика, промты. */
function renderShots(data) {
  const filter = $("#filter").value.trim().toLowerCase();
  const veo = new Map(data.videoPrompts.map((p) => [p.shot, p.text]));
  const img = new Map(data.prompts.map((p) => [p.shot, p.text]));
  const tpl = $("#shot-tpl").content;

  const shots = data.shots.filter((shot) => {
    if (!filter) return true;
    const haystack = `${shot.narration} ${shot.onScreen} ${shot.animated ? "анимация" : ""}`.toLowerCase();
    return haystack.includes(filter);
  });

  $("#counter").textContent = `показано ${shots.length} из ${data.shots.length}`;

  $("#shots").innerHTML = "";
  for (const shot of shots) {
    const node = tpl.cloneNode(true);
    node.firstElementChild.dataset.n = String(shot.n);
    node.querySelector(".num").textContent = String(shot.n).padStart(3, "0");
    node.querySelector(".narration").textContent = shot.narration;
    node.querySelector(".onscreen").textContent = shot.onScreen;

    if (shot.animated) node.querySelector(".anim").hidden = false;

    // Панель рисует сервер: это бесплатный слой, он есть всегда.
    const holder = node.querySelector(".panel");
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = `кадр ${shot.n}`;
    image.src = `/api/projects/${encodeURIComponent(current)}/panel/${shot.n}`;
    holder.append(image);

    const imagePrompt = node.querySelector("details .prompt");
    imagePrompt.textContent = img.get(shot.n) ?? "промт ещё не готов";
    const veoBox = node.querySelector("details.veo");
    if (veo.has(shot.n)) {
      veoBox.hidden = false;
      veoBox.querySelector(".prompt").textContent = veo.get(shot.n);
    }

    $("#shots").append(node);
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// ── действия ──────────────────────────────────────────────────────────────────

$("#create").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const { project } = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        minutes: Number(form.get("minutes")),
        language: form.get("language"),
      }),
    });
    event.target.reset();
    await loadCommon();
    await openProject(project.id);
  } catch (err) {
    alert(err.message);
  }
});

$("#projects").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]");
  if (button) openProject(button.dataset.id);
});

// Клик по стадии запускает только её: длинное видео доводят по шагам.
$("#stages").addEventListener("click", async (event) => {
  const item = event.target.closest("li[data-stage]");
  if (!item || !current) return;
  try {
    await api(`/api/projects/${encodeURIComponent(current)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stages: [item.dataset.stage] }),
    });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$("#run-all").addEventListener("click", async () => {
  if (!current) return;
  try {
    await api(`/api/projects/${encodeURIComponent(current)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$("#copy-prompts").addEventListener("click", async () => {
  const data = await api(`/api/projects/${encodeURIComponent(current)}`);
  const text = data.shots
    .map((shot) => {
      const prompt = data.prompts.find((p) => p.shot === shot.n)?.text ?? "";
      return `# кадр ${shot.n}\n${prompt}\n`;
    })
    .join("\n");
  if (!text.trim()) return alert("промтов пока нет");
  await navigator.clipboard.writeText(text);
  $("#copy-prompts").textContent = "Скопировано";
  setTimeout(() => ($("#copy-prompts").textContent = "Скопировать все промты"), 1600);
});

$("#shots").addEventListener("click", async (event) => {
  const button = event.target.closest(".copy");
  if (!button) return;
  const text = button.parentElement.querySelector(".prompt").textContent;
  await navigator.clipboard.writeText(text);
  const was = button.textContent;
  button.textContent = "Скопировано";
  setTimeout(() => (button.textContent = was), 1400);
});

/* Правка одного кадра моделью: иначе поправить реплику можно только прогоном всей
   стадии сценария. Сервер принимает ответ только целиком и говорит, что устарело. */
$("#shots").addEventListener("click", async (event) => {
  const button = event.target.closest(".rewrite");
  if (!button || !current) return;
  const card = button.closest(".shot");
  const note = card.querySelector(".edit-note");
  const field = button.dataset.field === "onScreen" ? "onScreen" : "narration";

  button.disabled = true;
  note.textContent = "модель думает…";
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(current)}/shots/${encodeURIComponent(card.dataset.n)}/rewrite`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: card.querySelector(".instruction").value, field }),
      },
    );
    if (result.changed) {
      card.querySelector(".narration").textContent = result.shot.narration;
      card.querySelector(".onscreen").textContent = result.shot.onScreen;
      note.textContent = result.rejected.length
        ? `принято не всё — ${result.rejected.join("; ")}`
        : "готово · промты, озвучка и монтаж теперь устарели";
      await refresh();
    } else {
      note.textContent = `не принято — ${result.rejected.join("; ") || "модель не изменила текст"}`;
    }
  } catch (err) {
    note.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$("#filter").addEventListener("input", async () => {
  if (current) renderShots(await api(`/api/projects/${encodeURIComponent(current)}`));
});

// Обновляем состояние, пока идёт работа: очередь двигается на сервере.
setInterval(() => {
  if (current) refresh().catch(() => {});
}, 4000);

await loadCommon();
if (state?.projects?.length) await openProject(state.projects[0].id);
