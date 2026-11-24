import "./style.css";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- copy to clipboard ---------- */
const toast = document.getElementById("toast");
let toastTimer;

function showToast(text) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-on"), 2400);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  showToast("Copied — paste it in Terminal");
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-copy]");
  if (!trigger) return;
  copy(trigger.dataset.copy);
  if (trigger.classList.contains("copy")) {
    const label = trigger.textContent;
    trigger.textContent = "copied";
    trigger.classList.add("is-done");
    setTimeout(() => {
      trigger.textContent = label;
      trigger.classList.remove("is-done");
    }, 1400);
  }
});

/* ---------- clock ---------- */
const clock = document.getElementById("clock");
function tick() {
  if (!clock) return;
  clock.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
tick();
setInterval(tick, 15_000);

/* ---------- scroll reveal ---------- */
const revealables = document.querySelectorAll(".reveal");
if (reduceMotion || !("IntersectionObserver" in window)) {
  revealables.forEach((node) => node.classList.add("is-in"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  revealables.forEach((node) => observer.observe(node));
}

/* ---------- pointer spotlight on cards ---------- */
if (!reduceMotion && window.matchMedia("(hover: hover)").matches) {
  document.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - box.left}px`);
      card.style.setProperty("--my", `${event.clientY - box.top}px`);
      card.classList.add("is-lit");
    });
    card.addEventListener("pointerleave", () => card.classList.remove("is-lit"));
  });
}

/* ---------- formatting ---------- */
function formatSize(bytes) {
  if (!bytes) return "unknown size";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function formatPlayed(unix) {
  if (!unix) return "never played";
  const delta = Date.now() / 1000 - unix;
  if (delta < 3600) return "played just now";
  if (delta < 86400) return `played ${Math.round(delta / 3600)}h ago`;
  if (delta < 2592000) return `played ${Math.round(delta / 86400)}d ago`;
  return `played ${new Date(unix * 1000).toLocaleDateString([], { month: "short", year: "numeric" })}`;
}

function summaries(game) {
  return game.kind === "shortcut"
    ? ["Non-Steam", formatPlayed(game.lastPlayed)]
    : [game.appid, formatSize(game.sizeOnDisk), formatPlayed(game.lastPlayed)];
}

function initials(name) {
  return name
    .replace(/^the\s+/i, "")
    .split(/[\s:—-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function artImage(game, { lazy = true } = {}) {
  if (!game.icon) return null;
  const img = document.createElement("img");
  img.alt = "";
  img.loading = lazy ? "lazy" : "eager";
  img.decoding = "async";
  img.src = game.icon;
  return img;
}

/* ---------- helpers ---------- */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ---------- console row ---------- */
const home = document.getElementById("home");
const rail = document.getElementById("rail");
const homeBg = document.getElementById("home-bg");
const homeCount = document.getElementById("home-count");
const stageKind = document.getElementById("stage-kind");
const stageTitle = document.getElementById("stage-title");
const stageMeta = document.getElementById("stage-meta");
const stagePlay = document.getElementById("stage-play");
const stageStatus = document.getElementById("stage-status");
const rescan = document.getElementById("rescan");

const launchEl = document.getElementById("launch");
const launchArt = document.getElementById("launch-art");
const launchBg = document.getElementById("launch-bg");
const launchName = document.getElementById("launch-name");
const launchStatus = document.getElementById("launch-status");
const launchBar = document.getElementById("launch-bar");
const launchClose = document.getElementById("launch-close");
const quitBtn = document.getElementById("quit");

let games = [];
// Unknown until the library answers; then it decides the empty-stage wording.
let steamInstalled = true;
let focused = 0;
let launching = false;

function tileFor(game, index) {
  const tile = document.createElement("button");
  tile.className = "tile";
  tile.type = "button";
  tile.dataset.index = String(index);
  tile.setAttribute("role", "option");
  tile.setAttribute("aria-label", game.name);

  const img = artImage(game, { lazy: index > 3 });
  if (img) tile.append(img);
  else {
    const fallback = document.createElement("span");
    fallback.className = "tile-initials";
    fallback.textContent = initials(game.name);
    tile.append(fallback);
  }

  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = game.name;
  tile.append(label);
  return tile;
}

function updateEmptyStage() {
  if (steamInstalled) {
    stageTitle.textContent = "No games in your bottles yet";
    stageMeta.textContent =
      "Open Steam below and sign in — your library appears here once you're in.";
  } else {
    stageTitle.textContent = "Set up Steam to get started";
    stageMeta.textContent =
      "Use Set up Steam below — MacForge builds the bottle, installs Steam and opens it once for sign-in.";
  }
}

function renderRail(data) {
  if (!rail) return;
  games = data.games;
  clear(rail);

  games.forEach((game, index) => rail.append(tileFor(game, index)));

  homeCount.textContent =
    games.length === 0 ? "empty" : `${games.length} ${games.length === 1 ? "game" : "games"}`;

  if (!games.length) {
    stageKind.textContent = "Empty";
    updateEmptyStage();
    stagePlay.disabled = true;
    stageStatus.textContent = "";
    homeBg.classList.remove("is-on");
    hideStageClip();
    return;
  }

  focusGame(0, { scroll: false });
}

function focusGame(index, { scroll = true } = {}) {
  if (!games.length) return;
  focused = (index + games.length) % games.length;
  const game = games[focused];

  [...rail.children].forEach((tile, position) => {
    const active = position === focused;
    tile.classList.toggle("is-focus", active);
    tile.setAttribute("aria-selected", active ? "true" : "false");
    if (active && scroll) {
      const offset = tile.offsetLeft - (rail.clientWidth - tile.clientWidth) / 2;
      rail.scrollTo({ left: offset, behavior: reduceMotion ? "auto" : "smooth" });
    }
  });

  stageKind.textContent =
    game.kind === "shortcut" ? `Non-Steam · ${game.bottle}` : `Steam · ${game.bottle}`;
  stageTitle.textContent = game.name;
  stageMeta.textContent = summaries(game).filter(Boolean).join(" · ");
  stagePlay.disabled = !game.launch;
  stageStatus.className = "home-status";
  stageStatus.textContent = "";

  if (game.icon) {
    homeBg.style.backgroundImage = `url("${game.icon}")`;
    homeBg.classList.add("is-on");
  } else {
    homeBg.classList.remove("is-on");
  }

  scheduleStageClip(game);

  // Once this clip is in hand, build the two beside it while nothing else is
  // happening, so sweeping the row never waits on a trailer.
  if (clipCache.has(String(game.appid))) {
    warmClips([games[focused + 1], games[focused - 1]].filter(Boolean).map((next) => next.appid));
  }
}

/* ---------- launch overlay ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openOverlay(game, tile) {
  launchEl.hidden = false;
  launchEl.classList.remove("is-error", "is-done");
  launchEl.classList.add("is-on");
  launchBar.classList.add("is-running");
  launchName.textContent = game.name;
  launchStatus.textContent = "Getting ready";
  launchClose.hidden = true;

  const art = game.icon ? `url("${game.icon}")` : "none";
  launchArt.style.backgroundImage = art;
  launchBg.style.backgroundImage = art;
  launchArt.textContent = game.icon ? "" : initials(game.name);

  requestAnimationFrame(() => zoomFrom(tile));
}

/** Fly the clicked tile into the centre of the screen, then hold it there. */
function zoomFrom(tile) {
  if (!tile || reduceMotion) return;

  const from = tile.getBoundingClientRect();
  const to = launchArt.getBoundingClientRect();
  if (!to.width) return;

  launchArt.style.transition = "none";
  launchArt.style.opacity = "0.5";
  launchArt.style.transform =
    `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`;
  void launchArt.offsetWidth;

  requestAnimationFrame(() => {
    launchArt.style.transition = "transform 0.62s cubic-bezier(0.2, 0.9, 0.25, 1), opacity 0.45s ease";
    launchArt.style.transform = "translate(0, 0) scale(1)";
    launchArt.style.opacity = "1";
  });
}

function markDone() {
  launchEl.classList.add("is-done");
  launchBar.classList.remove("is-running");
  launchStatus.textContent = "Running";
}

function failLaunch(message) {
  launchEl.classList.add("is-error");
  launchBar.classList.remove("is-running");
  launchStatus.textContent = message;
  launchClose.hidden = false;
}

function closeOverlay() {
  launchEl.classList.remove("is-on");
  setTimeout(() => {
    launchEl.hidden = true;
    launchEl.classList.remove("is-done", "is-error");
    launchArt.style.transition = "none";
    launchArt.style.transform = "none";
    launchArt.style.opacity = "1";
  }, 400);
  launching = false;
  const current = games[focused];
  stagePlay.disabled = !(current && current.launch);
  refreshRunning();
}

async function followLaunch(id) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await sleep(600);
    const response = await fetch(`/api/launch?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const job = await response.json().catch(() => ({}));
    if (!job.ok) continue;
    if (job.detail) launchStatus.textContent = job.detail;
    if (job.state === "ready") return;
    if (job.state === "error") throw new Error(job.detail || "launch failed");
  }
  throw new Error("timed out waiting for the game");
}

async function play() {
  const game = games[focused];
  if (!game || !game.launch || launching) return;

  launching = true;
  stagePlay.disabled = true;
  openOverlay(game, rail.children[focused]);

  try {
    const response = await fetch("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appid: game.appid, bottle: game.bottle }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

    if (data.dryRun) {
      launchStatus.textContent = "Dry run — no game started";
      markDone();
      setTimeout(closeOverlay, 1100);
      return;
    }

    await followLaunch(data.id);
    markDone();
    setTimeout(closeOverlay, 900);
  } catch (error) {
    failLaunch(`Couldn't start it — ${error.message}`);
  }
}

if (launchClose) launchClose.addEventListener("click", closeOverlay);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && launchEl && !launchEl.hidden) closeOverlay();
});

if (rail) {
  rail.addEventListener("click", (event) => {
    const tile = event.target.closest(".tile");
    if (!tile) return;
    const index = Number(tile.dataset.index);
    if (index === focused) play();
    else focusGame(index);
  });

  // Sliding across the row selects a game the way the arrow keys do, so the
  // clip follows the pointer without a click.
  rail.addEventListener("pointerover", (event) => {
    const tile = event.target.closest(".tile");
    if (!tile) return;
    const index = Number(tile.dataset.index);
    if (index !== focused) focusGame(index, { scroll: false });
  });
}

if (stagePlay) stagePlay.addEventListener("click", play);

window.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!games.length || !home || !launchEl.hidden) return;

  const box = home.getBoundingClientRect();
  const onScreen = box.top < window.innerHeight * 0.55 && box.bottom > 140;
  if (!onScreen) return;

  // A focused tile or button already gets Enter as a click; don't fire twice.
  if (event.target instanceof Element && event.target.closest(".tile, .btn")) return;

  if (event.key === "ArrowRight") {
    event.preventDefault();
    focusGame(focused + 1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    focusGame(focused - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    play();
  }
});

/* ---------- stop everything ---------- */

let quitArmed = false;
let quitTimer;

function disarmQuit() {
  quitArmed = false;
  clearTimeout(quitTimer);
  if (quitBtn) quitBtn.classList.remove("is-armed");
}

async function refreshRunning() {
  if (!quitBtn) return null;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const state = await response.json();
    if (!state.ok) throw new Error("status unavailable");
    quitBtn.hidden = !state.any;
    if (!quitArmed) quitBtn.textContent = state.games.length ? "stop game" : "stop steam";
    return state;
  } catch {
    quitBtn.hidden = true;
    return null;
  }
}

async function quitEverything() {
  if (!quitBtn) return;

  // Two taps, so a misclick doesn't throw away a session.
  if (!quitArmed) {
    quitArmed = true;
    quitBtn.classList.add("is-armed");
    quitBtn.textContent = "confirm?";
    quitTimer = setTimeout(async () => {
      disarmQuit();
      await refreshRunning();
    }, 3500);
    return;
  }

  disarmQuit();
  quitBtn.disabled = true;
  quitBtn.textContent = "stopping…";

  try {
    const response = await fetch("/api/quit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

    const names = [...(result.stopped.games ?? []), result.stopped.steam ? "Steam" : null]
      .filter(Boolean);
    showToast(names.length ? `Stopped ${names.join(" + ")}` : "Nothing was running");
  } catch (error) {
    showToast(`Couldn't stop it — ${error.message}`);
  } finally {
    quitBtn.disabled = false;
    quitBtn.textContent = "stop";
    await refreshRunning();
  }
}

if (quitBtn) quitBtn.addEventListener("click", quitEverything);
setInterval(refreshRunning, 6_000);
refreshRunning();

/* ---------- load ---------- */
async function loadGames() {
  if (!rail) return;
  homeCount.textContent = "scanning…";

  try {
    const response = await fetch("/api/games", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "scan failed");
    renderRail(data);
  } catch (error) {
    stageKind.textContent = `Offline · ${error.message || error}`;
    clear(rail);
    stageTitle.textContent = "Bottles not readable";
    stageMeta.textContent = "Open MacForge.app to scan them.";
    stagePlay.disabled = true;
    homeCount.textContent = "offline";
  }
}

if (rescan) rescan.addEventListener("click", loadGames);
loadGames();

/* ---------- owned library ---------- */

const libraryList = document.getElementById("library-list");
const librarySub = document.getElementById("library-sub");
const libraryFilter = document.getElementById("library-filter");
const libraryExtras = document.getElementById("library-extras");
const preflightEl = document.getElementById("preflight");

let multiBottle = false;
const dismissedSetup = new Set();

let libraryGames = [];
let librarySignature = "";
let libraryRetry;
let libraryPolls = 0;
let installWindowUntil = 0;
let pollingDownloads = false;
const failedDownloads = new Set();
let armedUninstall = null;
let warmedClips = false;

function sizeLabel(bytes) {
  if (!bytes || bytes < 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function speedLabel(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 1) return "waiting for data";
  if (bytesPerSecond >= 1e9) return `${(bytesPerSecond / 1e9).toFixed(2)} GB/s`;
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1e3))} KB/s`;
}

function etaLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m left`;
}

/** Cached art when Steam has some, initials when it does not. */
function libraryArt(game) {
  const blank = () => {
    const node = document.createElement("div");
    node.className = "lib-art lib-art-blank";
    node.textContent = initials(game.name ?? "");
    return node;
  };

  if (!game.art) return blank();

  const img = document.createElement("img");
  img.className = "lib-art";
  img.src = game.art;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => img.replaceWith(blank()), { once: true });
  return img;
}

/* One fetch per game, shared by the stage fill and the library hover card. */
const clipCache = new Map();

function clipFor(appid) {
  let pending = clipCache.get(appid);
  if (!pending) {
    pending = fetch(`/api/clip?appid=${appid}`)
      .then((response) => response.json())
      .catch(() => null);
    clipCache.set(appid, pending);
  }
  return pending;
}

/*
 * Clips are remuxed on first ask, which is seconds of ffmpeg the user should
 * never sit through. The ones that are about to be looked at are built ahead
 * of time, one at a time, and only while the page is actually visible.
 */
const warmQueue = [];
let warmTimer;
let warming = false;

function warmClips(appids) {
  for (const appid of appids) {
    if (!appid) continue;
    const id = String(appid);
    if (clipCache.has(id) || warmQueue.includes(id)) continue;
    warmQueue.push(id);
  }
  scheduleWarm();
}

function scheduleWarm() {
  clearTimeout(warmTimer);
  if (warming || !warmQueue.length) return;
  if (document.visibilityState !== "visible") return;

  warmTimer = setTimeout(async () => {
    warming = true;
    const appid = warmQueue.shift();
    try {
      if (appid && !clipCache.has(appid)) await clipFor(appid);
    } catch {
      // A trailer that cannot be built is recorded as a miss by the server.
    } finally {
      warming = false;
      scheduleWarm();
    }
  }, 1_200);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleWarm();
});

/* A short muted clip from the game's store trailer, while you are on its row. */
let clipCard;
let clipVideo;
let clipTitle;
let clipStatus;
let clipTimer;
let clipToken = 0;
let clipAppid = null;

function buildClipCard() {
  if (clipCard) return clipCard;

  clipCard = document.createElement("div");
  clipCard.className = "lib-clip";
  clipCard.hidden = true;

  clipVideo = document.createElement("video");
  clipVideo.className = "lib-clip-video";
  clipVideo.muted = true;
  clipVideo.loop = true;
  clipVideo.playsInline = true;
  clipVideo.preload = "auto";
  clipVideo.setAttribute("muted", "");
  clipVideo.setAttribute("playsinline", "");

  clipStatus = document.createElement("p");
  clipStatus.className = "lib-clip-status";
  clipStatus.textContent = "loading clip…";

  clipTitle = document.createElement("p");
  clipTitle.className = "lib-clip-title";

  clipCard.append(clipVideo, clipStatus, clipTitle);
  document.body.append(clipCard);
  return clipCard;
}

function scheduleClip(game) {
  if (!game?.appid) return;
  if (clipAppid === String(game.appid) && clipCard && !clipCard.hidden) return;

  clipAppid = String(game.appid);
  clearTimeout(clipTimer);
  // A quick sweep across the list should not queue a trailer per row.
  clipTimer = setTimeout(() => startClip(game), 180);
}

async function startClip(game) {
  const token = ++clipToken;

  buildClipCard();
  clipCard.hidden = false;
  clipCard.classList.remove("is-ready");
  clipTitle.textContent = game.name ?? `App ${game.appid}`;
  clipStatus.textContent = "loading clip…";
  clipVideo.pause();

  const clip = await clipFor(game.appid);
  if (token !== clipToken) return;

  if (!clip?.url) {
    clipStatus.textContent = "no trailer for this one";
    return;
  }

  if (clip.poster) clipVideo.poster = clip.poster;
  clipVideo.src = clip.url;
  clipCard.classList.add("is-ready");

  // play() itself starts the download, so try at once; if it raced the new
  // source it rejects, and canplay retries.
  const startPlaying = () => {
    if (token !== clipToken) return;
    const attempt = clipVideo.play();
    if (attempt?.catch) attempt.catch(() => {});
  };

  startPlaying();
  clipVideo.addEventListener("canplay", startPlaying, { once: true });
}

function hideClip() {
  clearTimeout(clipTimer);
  clipToken += 1;
  clipAppid = null;
  if (!clipCard) return;

  clipCard.hidden = true;
  clipVideo.pause();
}

/* The same trailer, big, filling the empty half of the console stage. */
const stageClip = document.getElementById("home-clip");
const stageClipVideo = document.getElementById("home-clip-video");
const stageClipStatus = document.getElementById("home-clip-status");
let stageClipTimer;
let stageClipToken = 0;
let stageClipAppid = null;

function scheduleStageClip(game) {
  if (!game?.appid) {
    hideStageClip();
    return;
  }

  const appid = String(game.appid);
  if (appid === stageClipAppid) return;

  stageClipAppid = appid;
  clearTimeout(stageClipTimer);

  // A warmed clip is already on disk, so the swap can happen at once. One that
  // has to be built waits for the row to settle first, or a quick sweep would
  // queue a trailer for every game it passes.
  if (clipCache.has(appid)) {
    startStageClip(appid);
    return;
  }

  stageClipTimer = setTimeout(() => startStageClip(appid), 220);
}

async function startStageClip(appid) {
  if (!stageClip) return;

  const token = ++stageClipToken;
  stageClip.hidden = false;
  stageClip.classList.remove("is-ready");
  stageClipStatus.textContent = "loading clip…";
  stageClipVideo.pause();

  const clip = await clipFor(appid);
  if (token !== stageClipToken) return;

  if (!clip?.url) {
    hideStageClip();
    return;
  }

  stageClipVideo.poster = clip.poster ?? "";
  stageClipVideo.src = clip.url;
  stageClipVideo.addEventListener(
    "canplay",
    () => {
      if (token === stageClipToken) stageClip.classList.add("is-ready");
    },
    { once: true },
  );

  const attempt = stageClipVideo.play();
  if (attempt?.catch) attempt.catch(() => {});
}

function hideStageClip() {
  clearTimeout(stageClipTimer);
  stageClipToken += 1;
  stageClipAppid = null;
  if (!stageClip) return;

  stageClip.hidden = true;
  stageClip.classList.remove("is-ready");
  stageClipVideo.pause();
}

function libraryRow(game) {
  const row = document.createElement("li");
  row.className = "lib-row";
  row.dataset.appid = game.appid;
  if (game.downloading || game.updating) row.classList.add("is-downloading");

  const art = libraryArt(game);

  const info = document.createElement("div");
  info.className = "lib-info";

  const name = document.createElement("h3");
  name.className = "lib-name";
  name.textContent = game.name ?? `App ${game.appid}`;

  const meta = document.createElement("p");
  meta.className = "lib-meta";
  const status = game.installed
    ? game.updating
      ? "updating"
      : "installed"
    : game.downloading
      ? "downloading"
      : game.name
        ? "owned"
        : "name pending";
  meta.textContent = [
    status,
    game.appid,
    !game.installed && game.installSize ? `${formatSize(game.installSize)} to download` : null,
    multiBottle ? game.bottle : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const progress = document.createElement("div");
  progress.className = "lib-progress";
  progress.hidden = !(game.downloading || game.updating);

  const bar = document.createElement("div");
  bar.className = "lib-bar";
  const fill = document.createElement("span");
  fill.className = "lib-bar-fill";
  bar.append(fill);

  const stats = document.createElement("p");
  stats.className = "lib-stats";
  stats.textContent = game.downloading || game.updating ? "Reading progress…" : "";
  progress.append(bar, stats);

  info.append(name, meta, progress);

  const action = document.createElement("div");
  action.className = "lib-action";

  if (game.installed && game.updating) {
    // Steam is updating it: the only control worth offering is the same pause a
    // download gets, because both are "stop the client, keep the files".
    const badge = document.createElement("span");
    badge.className = "lib-badge";
    badge.textContent = "updating";

    const pause = document.createElement("button");
    pause.type = "button";
    pause.className = "btn btn-ghost lib-ctrl lib-pause";
    pause.dataset.action = "pause";
    pause.textContent = "pause";
    pause.addEventListener("click", () => toggleDownload(game, pause));

    action.append(badge, pause);
  } else if (game.installed) {
    const tag = document.createElement("span");
    tag.className = "lib-installed";
    tag.textContent = "installed";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-ghost lib-uninstall";
    remove.textContent = "uninstall";
    remove.addEventListener("click", () => uninstallGame(game, remove));

    action.append(tag);

    if (game.updateAvailable) {
      const update = document.createElement("button");
      update.type = "button";
      update.className = "btn btn-primary lib-update";
      update.textContent = "update";
      update.title = game.updateBuild
        ? `Build ${game.updateBuild} is out; you have ${game.buildid ?? "an older one"}`
        : "Steam has an update for this game";
      update.addEventListener("click", () => updateGame(game, update));
      action.append(update);
    }

    // Available even when the game is up to date: this is the only way to ask
    // Steam to check files that may have gone bad on disk.
    const verify = document.createElement("button");
    verify.type = "button";
    verify.className = "btn btn-ghost lib-ctrl lib-verify";
    verify.textContent = "verify";
    verify.title = "Ask Steam to re-check this game's files";
    verify.addEventListener("click", () => verifyGame(game, verify));

    action.append(verify, remove);
  } else if (game.downloading) {
    const badge = document.createElement("span");
    badge.className = "lib-badge";
    badge.textContent = "downloading";

    const pause = document.createElement("button");
    pause.type = "button";
    pause.className = "btn btn-ghost lib-ctrl lib-pause";
    pause.dataset.action = "pause";
    pause.textContent = "pause";
    pause.addEventListener("click", () => toggleDownload(game, pause));

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost lib-ctrl lib-cancel";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => cancelDownload(game, cancel));

    action.append(badge, pause, cancel);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-primary lib-download";
    button.textContent = "Download";
    button.addEventListener("click", () => downloadGame(game, button));
    action.append(button);
  }

  row.append(art, info, action);
  return row;
}

/** Apps Steam lists beside the games: tools, servers, soundtracks, demos. */
function renderExtras(extras) {
  if (!libraryExtras) return;

  const items = extras?.items ?? [];
  if (!items.length) {
    libraryExtras.hidden = true;
    libraryExtras.replaceChildren();
    return;
  }

  const open = libraryExtras.dataset.open === "1";
  const label = (shown) =>
    `${shown ? "Hide" : "Show"} ${items.length} more ${items.length === 1 ? "app" : "apps"} Steam also lists`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "lib-extras-toggle";
  toggle.textContent = label(open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");

  const list = document.createElement("ul");
  list.className = "lib-extra-list";
  list.hidden = !open;

  for (const item of items) {
    const row = document.createElement("li");
    row.className = "lib-extra";

    const name = document.createElement("span");
    name.className = "lib-extra-name";
    name.textContent = item.name ?? `App ${item.appid}`;

    const type = document.createElement("span");
    type.className = "lib-extra-type";
    type.textContent = [item.type ?? "unidentified", item.installed ? "installed" : null]
      .filter(Boolean)
      .join(" · ");

    row.append(name, type);
    list.append(row);
  }

  toggle.addEventListener("click", () => {
    const next = list.hidden;
    list.hidden = !next;
    libraryExtras.dataset.open = next ? "1" : "0";
    toggle.textContent = label(next);
    toggle.setAttribute("aria-expanded", next ? "true" : "false");
  });

  libraryExtras.hidden = false;
  libraryExtras.replaceChildren(toggle, list);
}

function renderLibrary() {
  if (!libraryList) return;

  const term = (libraryFilter?.value ?? "").trim().toLowerCase();
  const shown = term
    ? libraryGames.filter((game) =>
        (game.name ?? `app ${game.appid}`).toLowerCase().includes(term) ||
        String(game.appid).includes(term),
      )
    : libraryGames;

  if (!shown.length) {
    const empty = document.createElement("li");
    empty.className = "lib-empty";
    empty.textContent = term
      ? `Nothing in your library matches “${term}”.`
      : "No owned games found in Steam's library cache yet.";
    libraryList.replaceChildren(empty);
    return;
  }

  libraryList.replaceChildren(...shown.map(libraryRow));
}

/** Update one row's progress in place, so the list never jumps while it fills. */
function paintDownload(appid, entry) {
  const row = libraryList?.querySelector(`[data-appid="${CSS.escape(String(appid))}"]`);
  if (!row) return;

  const game = libraryGames.find((item) => item.appid === String(appid));
  const progress = row.querySelector(".lib-progress");
  const fill = row.querySelector(".lib-bar-fill");
  const stats = row.querySelector(".lib-stats");
  const button = row.querySelector(".lib-download");
  const badge = row.querySelector(".lib-badge");
  const pause = row.querySelector(".lib-pause");
  const update = row.querySelector(".lib-update");
  const remove = row.querySelector(".lib-uninstall");
  if (!progress) return;

  if (entry.state === "error") {
    progress.hidden = true;
    row.classList.remove("is-downloading", "is-paused");
    if (button) {
      button.hidden = false;
      button.disabled = false;
      button.textContent = "Download";
    }
    if (update) {
      update.hidden = false;
      update.disabled = false;
      update.textContent = "update";
    }
    if (pause) pause.hidden = true;
    if (remove) remove.hidden = false;
    if (!failedDownloads.has(appid)) {
      failedDownloads.add(appid);
      showToast(`${game?.name ?? "Download"} failed — ${entry.detail}`);
    }
    return;
  }

  const paused = entry.state === "paused";
  progress.hidden = false;
  row.classList.add("is-downloading");
  row.classList.toggle("is-paused", paused);
  if (button) button.hidden = true;
  if (update) update.hidden = true;
  if (remove) remove.hidden = true;

  if (badge) {
    badge.textContent = paused ? "paused" : entry.state === "updating" ? "updating" : "downloading";
  }

  if (pause) {
    pause.hidden = false;
    pause.disabled = false;
    pause.dataset.action = paused ? "resume" : "pause";
    pause.textContent = paused ? "resume" : "pause";
  }

  if (!entry.total) {
    fill.style.width = "0%";
    stats.textContent = entry.detail || "starting…";
    return;
  }

  const pct = Math.max(1, Math.min(100, Math.round((entry.done / entry.total) * 100)));
  fill.style.width = `${pct}%`;

  const parts = [`${pct}%`, `${sizeLabel(entry.done)} of ${sizeLabel(entry.total)}`];
  // At 100% the bytes stop moving, so a speed reading there would read as zero.
  if (pct >= 100) {
    parts.push(entry.detail || "finishing up");
  } else {
    parts.push(speedLabel(entry.speed));
    const eta = etaLabel(entry.eta);
    if (eta) parts.push(eta);
  }
  stats.textContent = parts.join(" · ");
}

async function pollDownloads() {
  if (pollingDownloads) return;
  pollingDownloads = true;

  try {
    const response = await fetch("/api/downloads", { cache: "no-store" });
    const data = await response.json();
    if (!data.ok) return;

    const downloads = data.downloads ?? {};
    for (const [appid, entry] of Object.entries(downloads)) paintDownload(appid, entry);

    // A row that was downloading and now has no entry either finished or was
    // dropped: read the library again rather than guessing which.
    if (libraryGames.some((game) => game.downloading && !downloads[game.appid])) {
      loadLibrary();
    }
  } catch {
    // The next tick tries again.
  } finally {
    pollingDownloads = false;
  }
}

async function downloadGame(game, button) {
  button.disabled = true;
  button.textContent = "starting…";
  installWindowUntil = Date.now() + 240_000;

  const row = button.closest(".lib-row");
  const progress = row?.querySelector(".lib-progress");
  const stats = row?.querySelector(".lib-stats");
  if (progress) {
    progress.hidden = false;
    stats.textContent = "Getting Steam ready";
  }

  try {
    const response = await fetch("/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appid: game.appid }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

    button.textContent = "queued";
    showToast(`${game.name ?? `App ${game.appid}`} is downloading in the background`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Download";
    if (progress) progress.hidden = true;
    showToast(`Couldn't start ${game.name ?? "the download"} — ${error.message}`);
  }
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

/** Stops Steam where the download is, or starts it again where it left off. */
async function toggleDownload(game, button) {
  const action = button.dataset.action === "resume" ? "resume" : "pause";
  const label = game.name ?? `App ${game.appid}`;

  button.disabled = true;
  button.textContent = action === "pause" ? "pausing…" : "resuming…";

  try {
    await postJson("/api/download", { appid: game.appid, action });
    showToast(action === "pause" ? `Paused ${label}` : `Resuming ${label}`);
    await loadLibrary();
    pollDownloads();
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "pause" ? "pause" : "resume";
    showToast(`Couldn't ${action} ${label} — ${error.message}`);
  }
}

/** Two taps: this throws away every byte downloaded so far. */
async function cancelDownload(game, button) {
  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.classList.add("is-armed");
    button.textContent = "confirm?";
    setTimeout(() => {
      if (button.dataset.armed !== "1") return;
      button.dataset.armed = "0";
      button.classList.remove("is-armed");
      button.textContent = "cancel";
    }, 4000);
    return;
  }

  button.dataset.armed = "0";
  button.disabled = true;
  button.textContent = "cancelling…";

  try {
    const result = await postJson("/api/download", { appid: game.appid, action: "cancel" });
    showToast(
      `Cancelled ${game.name ?? `App ${game.appid}`}${result.freed ? ` — ${sizeLabel(result.freed)} freed` : ""}`,
    );
    libraryPolls = 0;
    await loadGames();
    await loadLibrary();
    loadPreflight();
  } catch (error) {
    button.disabled = false;
    button.textContent = "cancel";
    showToast(`Couldn't cancel it — ${error.message}`);
  }
}

/** Asks Steam to update a game in place, without its window. */
async function updateGame(game, button) {
  const label = game.name ?? `App ${game.appid}`;

  button.disabled = true;
  button.textContent = "updating…";
  installWindowUntil = Date.now() + 240_000;

  try {
    const result = await postJson("/api/update", { appid: game.appid });
    pollDownloads();
    const outcome = result.job ? await followJob(result.job) : null;
    jobToast(label, outcome, `Updating ${label} in the background`);
    libraryPolls = 0;
    await loadLibrary();
  } catch (error) {
    button.disabled = false;
    button.textContent = "update";
    showToast(`Couldn't update ${label} — ${error.message}`);
  }
}

/** Follows a background job far enough to report how it ended. */
async function followJob(id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(2000);
    const job = await fetch(`/api/job?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null);
    if (!job?.ok) return null;
    if (job.state === "error") return { error: job.detail };
    if (job.state === "done") return { done: job.detail };
    if (job.state === "downloading") return { started: job.detail };
  }
  return null;
}

function jobToast(label, outcome, fallback) {
  if (!outcome) return showToast(fallback);
  if (outcome.error) return showToast(`Couldn't finish ${label} — ${outcome.error}`);
  showToast(`${label} — ${outcome.done ?? outcome.started}`);
}

/** Asks Steam to re-check an installed game's files, in place. */
async function verifyGame(game, button) {
  // Two taps: if files are missing, Steam will download them again.
  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.classList.add("is-armed");
    button.textContent = "confirm?";
    setTimeout(() => {
      if (button.dataset.armed !== "1") return;
      button.dataset.armed = "0";
      button.classList.remove("is-armed");
      button.textContent = "verify";
    }, 4000);
    return;
  }

  const label = game.name ?? `App ${game.appid}`;
  button.dataset.armed = "0";
  button.disabled = true;
  button.textContent = "checking…";
  installWindowUntil = Date.now() + 240_000;

  try {
    const result = await postJson("/api/verify", { appid: game.appid });
    pollDownloads();
    const outcome = result.job ? await followJob(result.job) : null;
    jobToast(label, outcome, `Checking ${label} in the background`);
    libraryPolls = 0;
    await loadLibrary();
  } catch (error) {
    button.disabled = false;
    button.textContent = "verify";
    showToast(`Couldn't check ${label} — ${error.message}`);
  }
}

async function uninstallGame(game, button) {
  // Two taps: this deletes files and there is no Steam window to ask.
  if (armedUninstall !== game.appid) {
    armedUninstall = game.appid;
    button.textContent = "confirm?";
    button.classList.add("is-armed");
    setTimeout(() => {
      if (armedUninstall !== game.appid) return;
      armedUninstall = null;
      button.textContent = "uninstall";
      button.classList.remove("is-armed");
    }, 4000);
    return;
  }

  armedUninstall = null;
  button.disabled = true;
  button.textContent = "removing…";

  try {
    const response = await fetch("/api/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appid: game.appid }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

    showToast(
      `Uninstalled ${game.name ?? `App ${game.appid}`}${result.freed ? ` — ${sizeLabel(result.freed)} freed` : ""}`,
    );
    libraryPolls = 0;
    await loadGames();
    await loadLibrary();
    loadPreflight();
  } catch (error) {
    button.disabled = false;
    button.textContent = "uninstall";
    showToast(`Couldn't uninstall ${game.name ?? "it"} — ${error.message}`);
  }
}

async function loadLibrary() {
  if (!libraryList) return;

  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "the library is unavailable");

    libraryGames = Array.isArray(data.games) ? data.games : [];
    multiBottle = (data.bottles ?? []).length > 1;
    steamInstalled = (data.steamInstalled ?? 0) > 0;
    showSteamSetup(steamInstalled, libraryGames.length > 0);
    if (!games.length) updateEmptyStage();
    const installed = libraryGames.filter((game) => game.installed).length;
    // Steam's install state is polled while anything is downloading, so the
    // bottle card follows an install through to the moment it completes.
    showGameCount(installed);
    const downloading = libraryGames.filter((game) => game.downloading).length;
    const updating = libraryGames.filter((game) => game.updating).length;
    const updates = libraryGames.filter((game) => game.updateAvailable && !game.updating).length;
    const pending = data.pending ?? 0;
    const checking = data.checking ?? 0;

    if (librarySub) {
      const head = libraryGames.length
        ? `${libraryGames.length} games · ${installed} installed`
        : pending
          ? `Reading ${pending} library entries from Steam…`
          : "No owned games found in this bottle's Steam library cache.";

      const tail = [
        downloading ? `${downloading} downloading` : null,
        updating ? `${updating} updating` : null,
        updates ? `${updates} ${updates === 1 ? "update" : "updates"}` : null,
        pending ? `${pending} names still loading` : null,
      ].filter(Boolean);

      librarySub.textContent = tail.length ? `${head} · ${tail.join(" · ")}` : head;
    }

    // Re-render only when something visible changed; progress updates in place.
    const signature = libraryGames
      .map(
        (game) =>
          `${game.appid}:${game.name}:${game.installed}:${game.downloading}:${game.updating}:${game.updateAvailable}`,
      )
      .join("|");
    if (signature !== librarySignature) {
      librarySignature = signature;
      renderLibrary();
      renderExtras(data.extras);
    }

    // The installed games are the ones the stage shows first, so their clips
    // are the ones worth building before anybody asks for them.
    if (!warmedClips && libraryGames.length) {
      warmedClips = true;
      warmClips(
        [
          ...libraryGames.filter((game) => game.installed),
          ...libraryGames.filter((game) => !game.installed).slice(0, 4),
        ].map((game) => game.appid),
      );
    }

    clearTimeout(libraryRetry);
    if (pending > 0 || downloading > 0 || checking > 0) {
      libraryPolls += 1;
      if (libraryPolls < 400) libraryRetry = setTimeout(loadLibrary, pending ? 4_000 : 3_000);
    }
  } catch (error) {
    if (librarySub) librarySub.textContent = `Couldn't read the library — ${error.message}`;
  }
}

libraryFilter?.addEventListener("input", renderLibrary);

/* ---------- figures in the static cards ---------- */

const diskFree = document.getElementById("disk-free");
const diskMeter = document.getElementById("disk-meter");
const diskCaption = document.getElementById("disk-caption");
const bottlesSummary = document.getElementById("bottles-summary");

/** The disk card follows the volume the bottles sit on, not a number typed in. */
function showDisk(disk) {
  if (!disk?.total) return;

  const freeGb = Math.round(disk.free / 1e9);
  const totalGb = Math.round(disk.total / 1e9);
  const used = Math.min(100, Math.max(0, Math.round((1 - disk.free / disk.total) * 100)));

  if (diskFree) diskFree.innerHTML = `${freeGb}<span class="unit">GB free</span>`;
  if (diskMeter) diskMeter.style.width = `${used}%`;
  if (diskCaption) diskCaption.textContent = `of ${totalGb} GB · ${used}% used`;
}

function showGameCount(count) {
  if (!bottlesSummary) return;
  bottlesSummary.textContent =
    count === 0
      ? "Windows 10 · Steam · no games installed"
      : `Windows 10 · Steam · ${count} game${count === 1 ? "" : "s"} installed`;
}

/* ---------- setup check ---------- */

function renderPreflight(checks) {
  if (!preflightEl) return;

  const failed = checks.filter((check) => !check.ok && !dismissedSetup.has(check.id));
  preflightEl.hidden = !failed.length;
  if (!failed.length) {
    preflightEl.replaceChildren();
    return;
  }

  const rows = failed.map((check) => {
    const row = document.createElement("li");
    row.className = "pf-row";

    const body = document.createElement("div");
    body.className = "pf-body";

    const title = document.createElement("p");
    title.className = "pf-title";
    title.textContent = check.label;

    const detail = document.createElement("p");
    detail.className = "pf-detail";
    detail.textContent = check.detail;

    body.append(title, detail);
    row.append(body);

    if (check.action === "steam-setup") {
      const run = document.createElement("button");
      run.type = "button";
      run.className = "btn btn-primary pf-fix";
      run.textContent = "set up Steam";
      run.addEventListener("click", () => {
        steamSetupEl?.scrollIntoView({ behavior: "smooth", block: "center" });
        setupSteam();
      });
      row.append(run);
    } else if (check.fix) {
      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "btn btn-ghost pf-fix";
      fix.dataset.copy = check.fix;
      fix.textContent = "copy fix";
      row.append(fix);
    }

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "pf-dismiss";
    dismiss.textContent = "hide";
    dismiss.addEventListener("click", () => {
      dismissedSetup.add(check.id);
      renderPreflight(checks);
    });
    row.append(dismiss);

    return row;
  });

  preflightEl.replaceChildren(...rows);
}

let preflightAt = 0;

async function loadPreflight() {
  if (!preflightEl) return;
  preflightAt = Date.now();
  try {
    const data = await fetch("/api/preflight", { cache: "no-store" }).then((response) =>
      response.json(),
    );
    if (!data.ok) return;
    renderPreflight(data.checks ?? []);
    showDisk(data.disk);
  } catch {
    // A dead server is already reported by the library's own error state.
  }
}

loadPreflight();

/* ---------- our own Wine runtime ---------- */

const runtimeNote = document.getElementById("runtime-note");

let runtimeInstallPoll = null;

function runtimeProgress(state) {
  if (state.phase === "resolving") return "Looking up the Wine runtime MacForge runs games with…";
  if (state.phase === "downloading") {
    const got = sizeLabel(state.received);
    const total = state.total ? sizeLabel(state.total) : null;
    const percent = state.total ? ` (${Math.floor((state.received / state.total) * 100)}%)` : "";
    const speed = state.speed ? ` · ${speedLabel(state.speed)}/s` : "";
    return `Downloading the Wine runtime: ${got}${total ? ` of ${total}` : ""}${percent}${speed}. Games can launch when it finishes.`;
  }
  if (state.phase === "verifying") return "Checking the Wine runtime download…";
  if (state.phase === "extracting" || state.phase === "installing") return "Unpacking the Wine runtime…";
  return "Getting the Wine runtime ready…";
}

/** A fresh Mac has no Wine; the server fetches it while this follows along. */
async function followRuntimeInstall() {
  if (!runtimeNote) return;
  runtimeNote.hidden = false;
  runtimeNote.textContent = "Downloading the Wine runtime MacForge runs games with…";

  try {
    await fetch("/api/runtime/install", { method: "POST" });
  } catch {
    // The poll below reports a server that is not there.
  }

  if (runtimeInstallPoll) clearInterval(runtimeInstallPoll);
  runtimeInstallPoll = setInterval(async () => {
    let state;
    try {
      state = await fetch("/api/runtime/install", { cache: "no-store" }).then((response) =>
        response.json(),
      );
    } catch {
      return;
    }
    if (!state?.ok) return;

    if (state.running) {
      runtimeNote.textContent = runtimeProgress(state);
      return;
    }

    if (state.error) {
      runtimeNote.textContent = `The Wine runtime could not be downloaded: ${state.error}`;
      clearInterval(runtimeInstallPoll);
      runtimeInstallPoll = null;
      return;
    }

    if (state.done || state.already || state.phase === "done") {
      clearInterval(runtimeInstallPoll);
      runtimeInstallPoll = null;
      runtimeNote.textContent = "Wine runtime ready. Games can launch now.";
      loadRuntime();
      loadPreflight();
    }
  }, 1000);
}

async function loadRuntime() {
  if (!runtimeNote) return;
  try {
    const data = await fetch("/api/runtime", { cache: "no-store" }).then((response) =>
      response.json(),
    );
    if (!data?.ok) {
      followRuntimeInstall();
      return;
    }

    const where =
      data.source === "own"
        ? "this app's own copy"
        : data.source === "override"
          ? "the Wine WHISKY_GAMES_WINE points at"
          : "the Wine already on this Mac";
    const own = data.own?.dirs?.length ?? 0;
    runtimeNote.textContent = `Launches Windows games itself with ${data.version ?? "Wine"} (${where}), no Whisky CLI in the path.${own ? ` ${own} bottle${own === 1 ? "" : "s"} here ${own === 1 ? "was" : "were"} built by this app.` : ""}`;
    runtimeNote.hidden = false;
  } catch {
    // A dead server is already reported by the library's own error state.
  }
}

loadRuntime();

/* ---------- first-run Steam setup ---------- */

const steamSetupEl = document.getElementById("steam-setup");
const steamSetupText = document.getElementById("steam-setup-text");
const steamSetupRun = document.getElementById("steam-setup-run");

let steamSetupId = null;
let steamSetupPoll = null;

/**
 * No Steam install means nothing to launch yet. This offers to build a bottle
 * and install Steam instead of leaving a downloaded app with an empty library.
 */
function steamSetupButton(label, action) {
  if (!steamSetupRun) return;
  steamSetupRun.hidden = false;
  steamSetupRun.disabled = false;
  steamSetupRun.dataset.action = action;
  steamSetupRun.textContent = label;
}

function showSteamSetup(installed, hasGames) {
  if (!steamSetupEl) return;
  // A running job owns the card's text until it finishes.
  if (steamSetupId || steamSetupRun?.disabled) return;

  if (!installed) {
    steamSetupEl.hidden = false;
    steamSetupText.textContent =
      "No Steam bottle yet. MacForge can build one, install Steam and open it once so you can sign in — your games appear here afterwards.";
    steamSetupButton("Set up Steam", "setup");
    return;
  }

  // Installed but not signed in: Steam has no library cache to show yet.
  if (!hasGames) {
    steamSetupEl.hidden = false;
    steamSetupText.textContent =
      "Steam is installed. Sign in there once — your games will appear here when you're in.";
    steamSetupButton("Open Steam", "open");
    return;
  }

  steamSetupEl.hidden = true;
}

/** After sign-in Steam writes its library cache; pick that up without a reload. */
function followSteamSignIn() {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts += 1;
    await Promise.all([loadGames(), loadLibrary()]);
    if (libraryGames.length || attempts >= 60) clearInterval(timer);
  }, 5_000);
}

async function setupSteam() {
  if (!steamSetupRun) return;

  if (steamSetupEl) steamSetupEl.hidden = false;
  steamSetupRun.hidden = false;
  steamSetupRun.disabled = true;
  steamSetupRun.textContent = "starting…";
  steamSetupText.textContent = "Creating the bottle…";

  try {
    const result = await postJson("/api/setup/steam", {});
    if (result.already) {
      steamSetupId = null;
      await loadLibrary();
      return;
    }

    steamSetupId = result.id ?? result.job ?? null;
    if (!steamSetupId) throw new Error("the setup did not return a job");

    clearInterval(steamSetupPoll);
    steamSetupPoll = setInterval(async () => {
      const job = await fetch(`/api/job?id=${encodeURIComponent(steamSetupId)}`, {
        cache: "no-store",
      })
        .then((response) => response.json())
        .catch(() => null);
      if (!job?.ok) return;

      if (job.state === "error") {
        clearInterval(steamSetupPoll);
        steamSetupPoll = null;
        steamSetupId = null;
        steamSetupText.textContent = `Steam setup stopped: ${job.detail}`;
        steamSetupRun.hidden = false;
        steamSetupRun.disabled = false;
        steamSetupRun.textContent = "Try again";
        return;
      }

      if (job.state === "done") {
        clearInterval(steamSetupPoll);
        steamSetupPoll = null;
        steamSetupId = null;
        steamSetupText.textContent = job.detail;
        steamSetupRun.disabled = false;
        steamSetupRun.hidden = true;
        showToast("Steam is open — sign in there once");
        await Promise.all([loadGames(), loadBottles(), loadLibrary(), loadPreflight()]);
        followSteamSignIn();
        return;
      }

      steamSetupText.textContent = job.detail || "Setting up Steam…";
    }, 1_500);
  } catch (error) {
    steamSetupText.textContent = `Couldn't start the Steam setup — ${error.message}`;
    steamSetupRun.disabled = false;
    steamSetupRun.textContent = "Try again";
  }
}

/** If the user closed Steam before signing in, bring its window back. */
async function openSteam() {
  if (!steamSetupRun) return;

  steamSetupRun.disabled = true;
  steamSetupRun.textContent = "opening…";

  try {
    await postJson("/api/steam/open", {});
    showToast("Steam is open — sign in there once");
    followSteamSignIn();
  } catch (error) {
    showToast(`Couldn't open Steam — ${error.message}`);
  } finally {
    steamSetupRun.disabled = false;
    steamSetupRun.textContent = "Open Steam";
  }
}

if (steamSetupRun) {
  steamSetupRun.addEventListener("click", () => {
    if (steamSetupRun.dataset.action === "open") openSteam();
    else setupSteam();
  });
}

/* ---------- moving games off Whisky ---------- */

const migrateEl = document.getElementById("migrate");
const migrateText = document.getElementById("migrate-text");
const migrateRun = document.getElementById("migrate-run");

let migrateArmed = false;
let migrateTimer;

/**
 * A bottle Whisky made still sits in Whisky's folder. Until it moves, deleting
 * Whisky would take the games with it, so this is offered rather than assumed:
 * it stops what is running and renames the folder, which is instant because
 * both places are on the same volume.
 */
async function loadBottles() {
  if (!migrateEl) return;

  try {
    const data = await fetch("/api/bottles", { cache: "no-store" }).then((response) =>
      response.json(),
    );
    const bottles = data?.bottles ?? [];
    const pending = bottles.filter((bottle) => !bottle.conflict);
    const blocked = bottles.filter((bottle) => bottle.conflict);

    if (!data?.ok || !pending.length) {
      migrateEl.hidden = true;
      return;
    }

    const games = pending.reduce((total, bottle) => total + (bottle.games ?? 0), 0);
    migrateText.textContent =
      `${pending.length} ${pending.length === 1 ? "bottle" : "bottles"} (${games} installed ${games === 1 ? "game" : "games"}) still ${pending.length === 1 ? "sits" : "sit"} in Whisky's folder. ` +
      "Moving them keeps every game after Whisky is gone: Steam and any game stop first, then the folders are renamed where they are, not copied." +
      (blocked.length ? ` ${blocked.length} more cannot move because the name is taken here.` : "");

    migrateRun.hidden = false;
    migrateRun.disabled = false;
    migrateEl.hidden = false;
  } catch {
    migrateEl.hidden = true;
  }
}

async function migrateOffWhisky() {
  if (!migrateRun) return;

  // Two taps: this stops whatever is running.
  if (!migrateArmed) {
    migrateArmed = true;
    migrateRun.classList.add("is-armed");
    migrateRun.textContent = "confirm? games will stop";
    migrateTimer = setTimeout(() => {
      migrateArmed = false;
      migrateRun.classList.remove("is-armed");
      migrateRun.textContent = "Move games off Whisky";
    }, 6000);
    return;
  }

  clearTimeout(migrateTimer);
  migrateArmed = false;
  migrateRun.classList.remove("is-armed");
  migrateRun.disabled = true;
  migrateRun.textContent = "moving…";

  try {
    const result = await postJson("/api/bottles/migrate", {});
    const outcome = result.id ? await followJob(result.id) : null;

    if (result.nothing) showToast("Nothing is left in Whisky's folder");
    else jobToast("Your bottles", outcome, `Moved ${result.bottles ?? 0} bottles`);

    await Promise.all([loadBottles(), loadGames(), loadLibrary()]);
  } catch (error) {
    showToast(`Couldn't move them — ${error.message}`);
  } finally {
    migrateRun.disabled = false;
    migrateRun.textContent = "Move games off Whisky";
  }
}

if (migrateRun) migrateRun.addEventListener("click", migrateOffWhisky);
loadBottles();

/* ---------- why a game closed ---------- */

let lastCrashId = null;
let crashBaseline = false;

/**
 * The server writes a report whenever a game stops without being asked to. One
 * toast per report is enough here; the full log is at /api/crash?id=…
 */
async function pollCrashes() {
  try {
    const data = await fetch("/api/crashes?limit=1", { cache: "no-store" }).then((response) =>
      response.json(),
    );
    const newest = data?.crashes?.[0];
    if (!newest) return;

    // Reports that predate this page are history, not news.
    if (!crashBaseline) {
      crashBaseline = true;
      lastCrashId = newest.id;
      return;
    }

    if (newest.id === lastCrashId) return;
    lastCrashId = newest.id;
    if (!newest.unexpected) return;

    // A short, silent exit is far more often a first-run terms screen than a
    // crash, and "accept it once" is the fix the user can actually act on.
    const guessed = newest.firstRun
      ? " — if it was showing a terms or sign-in screen, accept it once and press Play again"
      : " — report saved";

    showToast(`${newest.name ?? "The game"} closed${guessed}`);
    if (stageStatus) {
      stageStatus.className = "home-status is-error";
      stageStatus.textContent = newest.firstRun
        ? `${newest.name ?? "The game"} closed right after starting · a first run may need its terms screen accepted · /api/crash?id=${newest.id}`
        : `${newest.name ?? "The game"} closed unexpectedly · /api/crash?id=${newest.id}`;
    }
  } catch {
    // The interval tries again.
  }
}

setInterval(pollCrashes, 8_000);
pollCrashes();

// Delegated on the list itself: rows are rebuilt when the library changes, but
// the list element survives, so hover keeps working across a refresh.
libraryList?.addEventListener("pointerover", (event) => {
  const row = event.target instanceof Element ? event.target.closest(".lib-row") : null;
  if (!row) return;

  const game = libraryGames.find((entry) => entry.appid === row.dataset.appid);
  if (game) scheduleClip(game);
});

libraryList?.addEventListener("pointerleave", hideClip);

setInterval(() => {
  if (
    libraryGames.some((game) => game.downloading || game.updating) ||
    Date.now() < installWindowUntil
  ) {
    pollDownloads();
    // Steam stages and then frees bytes as it works, so the disk card follows
    // the same window instead of only reading the disk once at startup.
    if (Date.now() - preflightAt > 5_000) loadPreflight();
  }
}, 1_000);

loadLibrary();
