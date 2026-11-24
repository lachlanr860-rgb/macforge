import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { detect, listBottles, readManifests, readOwnedLibrary, resolveGridArt, WHISKY_CLI } from "./detect.mjs";
import {
  launch as wineLaunch,
  run as wineRun,
  runtime as wineRuntime,
  createBottle as makeBottle,
  selfTest as runtimeSelfTest,
  info as runtimeInfo,
  OWN_BOTTLES,
} from "./runtime.mjs";
import { payloadSelfTest, payloadStatus, prepareBottle } from "./payloads.mjs";
import { listCrashes, logSince, readCrash, recordCrash, signalsIn } from "./crashes.mjs";
import { migrateBottles, migrationPlan } from "./migrate.mjs";
import { installRuntime, runtimeInstallStatus } from "./runtime-install.mjs";

/**
 * One implementation of the JSON API, shared by the Vite dev server and the
 * standalone server that ships inside the .app.
 *
 * Launching is a job, not a fire-and-forget spawn: the UI needs to know when
 * Steam is quietly up and when the game's window is actually running, so it can
 * hold a loading screen and then get out of the way.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", ""]);

// A Mac with no Wine anywhere cannot launch a game. Fetch the tree this app
// owns on first launch, in the background, and let the page show the progress.
// MACFORGE_NO_AUTO_RUNTIME=1 keeps a development machine from doing this.
if (process.env.MACFORGE_NO_AUTO_RUNTIME !== "1") {
  const autoRuntime = setTimeout(() => {
    if (wineRuntime().ok) return;
    installRuntime().catch(() => {});
  }, 2500);
  autoRuntime.unref?.();
}

/**
 * The Host header says which address a request arrived on; it says nothing
 * about who sent it. Any page in any browser can POST to a loopback port, so
 * the routes that stop Steam, download or delete files also check the caller:
 * same-origin fetches only, never a sandboxed frame's opaque "null" origin.
 */
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return false;

  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const STEAM_EXES = [
  "C:\\Program Files (x86)\\Steam\\steam.exe",
  "C:\\Program Files\\Steam\\steam.exe",
];

const jobs = new Map();
let jobCounter = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function processes() {
  try {
    return execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const steamRunning = () => processes().some((line) => line.includes("Steam\\steam.exe"));

/**
 * PIDs whose image is exactly this executable. `SkyrimSELauncher.exe` contains
 * the substring `SkyrimSE`, the WhiskyCmd wrapper carries the path as an
 * argument, and Wine's `start /unix …` helper does too, so all three are
 * excluded by exact-name matching on a word boundary.
 */
function matchingPids(exe) {
  const escaped = exe.split("\\").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[\\s/\\\\])${escaped}([\\s]|$)`);
  const found = [];

  for (const line of processes()) {
    const space = line.indexOf(" ");
    if (space < 1) continue;
    const args = line.slice(space + 1);
    if (args.includes("WhiskyCmd") || args.includes("/unix")) continue;
    if (pattern.test(args)) found.push(line.slice(0, space));
  }

  return found;
}

/**
 * Sessions worth reporting on, keyed by bottle and executable. A game is only a
 * session once it actually ran: a launch that dies in the first seconds is the
 * job's own error, already shown in the overlay.
 */
const sessions = new Set();

/**
 * When the user asks for everything to stop, the games that follow are not
 * crashes. Any stop in this window counts as asked-for.
 */
let stopRequestedAt = 0;
const noteStop = () => {
  stopRequestedAt = Date.now();
};

function logSize(file) {
  try {
    return existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
}

/**
 * Every process running out of a game's install folder. Many games hand off to
 * a second binary — a launcher stub, a UE `-Shipping.exe` — so the image the
 * manifest points at can be gone while the game is still on screen. Watching
 * one image would report a crash every time a healthy game starts that way.
 */
function gameProcesses(game) {
  if (!game.installdir) return game.exe ? matchingPids(game.exe) : [];

  const folder = game.installdir.toLowerCase();
  const needles = [`steamapps/common/${folder}`, `steamapps\\common\\${folder}`];
  const found = [];

  for (const line of processes()) {
    const lower = line.toLowerCase();
    if (!needles.some((needle) => lower.includes(needle))) continue;

    const space = line.indexOf(" ");
    if (space < 1) continue;
    const args = line.slice(space + 1);
    if (args.includes("WhiskyCmd") || args.includes("/unix")) continue;
    found.push(line.slice(0, space));
  }

  return found;
}

/**
 * Watch a game after its launch reports success and record how it ended. Wine
 * gives no exit code to the app because wineserver owns the process, so what is
 * left to record is the log Steam wrote while the game was up and the lines
 * that name a failure.
 */
function watchSession(game, log) {
  const key = `${game.bottle}:${game.installdir ?? game.exe}`;
  if (!game.exe && !game.installdir) return;
  if (sessions.has(key)) return;
  sessions.add(key);

  const startedAt = Date.now();
  const offset = logSize(log);

  // The content log only writes on state changes, so a short session leaves it
  // empty. The client log is where Steam records the game's own start and stop,
  // which is what makes a report readable.
  const clientLog = log ? path.join(path.dirname(log), "console_log.txt") : null;
  const clientOffset = logSize(clientLog);

  const timer = setInterval(() => {
    if (gameProcesses(game).length) {
      if (Date.now() - startedAt > 12 * 60 * 60 * 1000) clearInterval(timer);
      return;
    }

    clearInterval(timer);
    sessions.delete(key);

    const endedAt = Date.now();
    const seconds = Math.round((endedAt - startedAt) / 1000);
    if (seconds < 10) return;

    const expected = stopRequestedAt > 0 && endedAt - stopRequestedAt < 120_000;

    const content = logSince(log, offset, 120);
    const client = logSince(clientLog, clientOffset, 600)
      .filter(
        (line) =>
          line.includes(String(game.appid)) ||
          /game process|app state|files missing|failed|crash/i.test(line),
      )
      .slice(-80);
    const lines = [...content, ...client];

    recordCrash({
      appid: game.appid,
      name: game.name,
      bottle: game.bottle,
      exe: game.exe,
      startedAt,
      endedAt,
      seconds,
      unexpected: !expected,
      signals: signalsIn(lines),
      logTail: lines,
    });
  }, 5_000);

  timer.unref?.();
}

/**
 * Every launch in this file funnels through here. The callers speak Whisky's
 * shape — ["run", bottle, exe, "--", ...args] — but the launch is performed by
 * this app's own Wine runtime, so Whisky does not have to be installed at all.
 * The CLI stays as the fallback for a Mac whose Wine tree is missing.
 */
function spawnDetached(args) {
  const [verb, bottleName, windowsExe, ...rest] = args;
  const extra = rest[0] === "--" ? rest.slice(1) : rest;

  if (verb === "run" && windowsExe) {
    const dir = bottleDirNamed(bottleName);
    if (dir && wineRuntime().ok) {
      wineLaunch(dir, windowsExe, extra);
      return;
    }
  }

  const child = spawn(WHISKY_CLI, args, { detached: true, stdio: "ignore" });
  child.unref();
}

/** A bottle's folder from the name the interface and the manifests use. */
function bottleDirNamed(name) {
  const bottle = bottleNames().find((entry) => entry.name === name || entry.id === name);
  const id = bottle?.id ?? name;
  return listBottles().find((dir) => path.basename(dir) === id) ?? null;
}

async function waitFor(test, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test()) return true;
    await sleep(intervalMs);
  }
  return test();
}

/** Rebuild the command from a fresh scan: never trust a client-supplied command. */
function resolveGame(body) {
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return { status: 400, error: "Body must be JSON" };
  }

  const { appid, bottle } = payload ?? {};
  if (typeof appid !== "string" || typeof bottle !== "string") {
    return { status: 400, error: "appid and bottle are required" };
  }

  const game = detect().games.find((entry) => entry.appid === appid && entry.bottle === bottle);
  if (!game) return { status: 404, error: "That game is not installed in that bottle" };
  return { game };
}

/**
 * The bottle that owns a Steam install: it holds the client log we read to know
 * when Steam is really ready rather than merely running.
 */
function steamBottleLog() {
  for (const dir of listBottles()) {
    const log = path.join(dir, "drive_c/Program Files (x86)/Steam/logs/content_log.txt");
    if (existsSync(log)) return log;
  }
  return null;
}

const stampNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/**
 * Steam only accepts a launch request once its client has loaded the library,
 * which it logs in content_log.txt. Sending -applaunch earlier is dropped, so
 * the app would appear to do nothing at all.
 */
function steamReadySince(log, since) {
  if (!log || !existsSync(log)) return false;

  let text;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return false;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!/Loaded \d+ apps from install folder/.test(line)) continue;
    const stamp = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(line);
    if (!stamp) continue;
    if (!since || stamp[1] >= since) return true;
  }

  return false;
}

/**
 * Skyrim Special Edition never skips its own launcher when started directly:
 * the game binary hands straight over to SkyrimSELauncher.exe, and Steam's own
 * launch target for appid 489830 is that launcher too. The only launch that
 * reaches the game is one Steam performs, so SkyrimSELauncher.exe is replaced
 * by a stub (build.sh) that starts the real game as Steam's own child.
 */
async function runJob(job, game) {
  try {
    const log = steamBottleLog();
    const since = stampNow();
    const wasRunning = steamRunning();
    const known = game.exe ? new Set(matchingPids(game.exe)) : new Set();
    const gameUp = () => (game.exe ? matchingPids(game.exe).some((pid) => !known.has(pid)) : false);

    // Boot Steam and ask for the game in one invocation: a second steam.exe
    // cannot reach a client that is already running, and -applaunch is dropped.
    const startBoth = () => {
      job.state = "steam";
      job.detail = "Starting Steam quietly";
      spawnDetached([
        "run",
        game.bottle,
        STEAM_EXES[0],
        "--",
        "-silent",
        "-applaunch",
        String(game.appid),
      ]);
    };

    if (!wasRunning) {
      startBoth();
    } else {
      job.state = "steam";
      job.detail = "Waiting for Steam";
    }

    if (!(await waitFor(steamRunning, 60_000, 600))) {
      throw new Error("Steam didn't start in the bottle");
    }

    job.state = "steam";
    job.detail = "Waiting for Steam";
    // When we started the client, only a library load from this run counts; a
    // Steam that was already up simply has to have finished one. A cold boot is
    // slow — after a Wine runtime switch Steam ran an installation verification
    // first and took about four minutes to load its library — so the wait has to
    // outlast that. Timing out here reports failure while the game is still
    // about to start, which is worse than waiting.
    if (!(await waitFor(() => steamReadySince(log, wasRunning ? "" : since), 300_000, 700))) {
      throw new Error("Steam didn't finish loading");
    }

    job.state = "starting";
    job.detail = `Starting ${game.name}`;

    if (wasRunning && !gameUp()) {
      // Steam was already up and may have dropped the request; ask it directly.
      spawnDetached([
        "run",
        game.bottle,
        STEAM_EXES[0],
        "--",
        "-applaunch",
        String(game.appid),
      ]);
    }

    job.state = "loading";
    job.detail = "Loading";

    // A cold boot plus a first-time shader compile is slow; be patient once,
    // then fall back to a clean restart rather than reporting a false success.
    // A warm Steam either hands off within seconds or silently dropped it; a
    // cold boot needs the client's full startup first.
    let up = await waitFor(gameUp, wasRunning ? 20_000 : 180_000, 700);

    if (!up) {
      job.detail = "Restarting Steam quietly";
      noteStop();
      for (const dir of listBottles()) await stopBottle(dir);
      await sleep(2_500);

      const retrySince = stampNow();
      startBoth();
      await waitFor(steamRunning, 60_000, 600);
      await waitFor(() => steamReadySince(log, retrySince), 300_000, 700);
      up = await waitFor(gameUp, 120_000, 700);
    }

    if (!up) throw new Error("The game didn't appear");

    // A process that starts and dies at once is a failed launch, not a running
    // game; only report success once it has survived a moment.
    const fresh = game.exe ? matchingPids(game.exe).filter((pid) => !known.has(pid)) : [];
    await sleep(4_000);
    const survivors = game.exe ? matchingPids(game.exe) : [];
    if (game.exe && !fresh.some((pid) => survivors.includes(pid))) {
      // The most common reason a Windows game shows a window and disappears on
      // its very first run is a terms or EULA screen it could not draw or that
      // was answered by closing it. Saying so is more useful than the fact.
      throw new Error(
        "The game started and exited — a first run may need a terms, EULA or sign-in window accepted; do that once, then press Play again",
      );
    }

    // The process is up, but its window only appears once DXVK has compiled a
    // first frame (measured: about ten seconds after the process on a cold
    // run). Keep the loading screen until then rather than flashing the user
    // back to the desktop.
    await sleep(10_000);

    job.state = "ready";
    job.detail = "Running";
    job.finishedAt = Date.now();

    // From here the launch is done and the session is what matters: a game that
    // closes later on is a crash report, not a failed launch.
    watchSession(game, log);
  } catch (error) {
    job.state = "error";
    job.detail = error instanceof Error ? error.message : String(error);
  } finally {
    setTimeout(() => jobs.delete(job.id), 300_000).unref?.();
  }
}

function startLaunch(res, game) {
  if (!wineRuntime().ok && !existsSync(WHISKY_CLI)) {
    sendJson(res, 501, { ok: false, error: "No Wine runtime found — run node scripts/fetch-runtime.mjs" });
    return;
  }

  const command =
    game.kind === "steam"
      ? `wine64 start /unix '${STEAM_EXES[0]}' -silent -applaunch ${game.appid}`
      : `wine64 start /unix '${game.exe}'`;

  if (process.env.WHISKY_GAMES_DRY === "1") {
    sendJson(res, 200, {
      ok: true,
      dryRun: true,
      name: game.name,
      command,
      state: "ready",
      detail: "Running",
    });
    return;
  }

  jobCounter += 1;
  const job = {
    id: `l${Date.now().toString(36)}${jobCounter}`,
    name: game.name,
    state: "queued",
    detail: "Getting ready",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);

  runJob(job, game);

  sendJson(res, 200, { ok: true, id: job.id, name: game.name, command });
}

/**
 * Move Whisky's bottles into this app's folder. Anything running has to stop
 * first: a rename under a live prefix is how a bottle gets corrupted.
 */
async function runMigration(job) {
  try {
    const before = runningState();
    if (before.any) {
      job.state = "stopping";
      job.detail = "Stopping Steam and games";
      noteStop();
      for (const dir of listBottles()) await stopBottle(dir);
      await sleep(1_500);
    }

    job.state = "moving";
    job.detail = "Moving bottles";

    const result = migrateBottles();
    job.result = result;
    job.state = result.ok ? "done" : "error";
    job.detail = result.ok
      ? `Moved ${result.moved} ${result.moved === 1 ? "bottle" : "bottles"} into this app's folder`
      : result.results
          .filter((entry) => !entry.ok)
          .map((entry) => `${entry.id}: ${entry.error}`)
          .join("; ")
          .slice(0, 300) || "Nothing moved";
    job.finishedAt = Date.now();
  } catch (error) {
    job.state = "error";
    job.detail = error instanceof Error ? error.message : String(error);
  } finally {
    setTimeout(() => jobs.delete(job.id), 300_000).unref?.();
  }
}

/** wineserver from the same runtime the app launches with. */
const wineserverBin = () => wineRuntime().wineserver;

const STEAM_MARKER = "Steam\\steam.exe";

/** What is running in the bottles right now. */
function runningState() {
  let data;
  try {
    data = detect();
  } catch {
    data = { bottles: [], games: [] };
  }

  const steam = processes().some((line) => line.includes(STEAM_MARKER));
  const games = [];
  const bottles = [];

  for (const bottle of data.bottles) {
    const names = [];
    for (const game of data.games) {
      if (game.bottle !== bottle.name || !game.exe) continue;
      if (matchingPids(game.exe).length) names.push(game.name);
    }
    if (names.length) {
      games.push(...names);
      bottles.push({ id: bottle.id, name: bottle.name, games: names });
    }
  }

  return { ok: true, steam, games, bottles, any: steam || games.length > 0 };
}

/** wineserver -k tears down every Windows process in that prefix. */
function stopBottle(bottleDir) {
  return new Promise((resolve) => {
    const server = wineserverBin();
    if (!server || !existsSync(server)) return resolve(false);
    const child = spawn(server, ["-k"], {
      env: { ...process.env, WINEPREFIX: bottleDir },
      stdio: "ignore",
    });
    child.on("exit", () => resolve(true));
    child.on("error", () => resolve(false));
    setTimeout(() => resolve(true), 8_000).unref?.();
  });
}

/* ---------------- owned library ---------------- */

const NAME_CACHE = path.join(homedir(), "Library", "Caches", "MacForge", "appinfo.json");
const NAME_TTL = 7 * 24 * 60 * 60 * 1000;
const NAME_MISS_TTL = 3 * 24 * 60 * 60 * 1000;
const NAME_BATCH = 50;
const USER_AGENT = "MacForge/1.0";

// Steam answers a whole batch of appids in one request, so a library is named in
// a handful of calls instead of one throttled request per game.
const nameQueue = [];
const nameAttempts = new Map();
let namesRunning = false;

/** Bottle display names, which a launch needs instead of the folder id. */
let bottleNamesAt = 0;
let bottleNamesCache = [];

function bottleNames() {
  if (Date.now() - bottleNamesAt < 2_000) return bottleNamesCache;
  try {
    bottleNamesCache = detect().bottles;
  } catch {
    bottleNamesCache = [];
  }
  bottleNamesAt = Date.now();
  return bottleNamesCache;
}

/** The Steam install inside one bottle, if it has one. */
function steamBottleIn(dir, names) {
  for (const rel of ["drive_c/Program Files (x86)/Steam", "drive_c/Program Files/Steam"]) {
    const steam = path.join(dir, rel);
    if (!existsSync(path.join(steam, "appcache"))) continue;
    const id = path.basename(dir);
    return {
      dir,
      steam,
      id,
      name: names.find((bottle) => bottle.id === id)?.name ?? id,
      exe: steam.includes("Program Files (x86)") ? STEAM_EXES[0] : STEAM_EXES[1],
    };
  }
  return null;
}

/** Every bottle with a Steam install. A Mac can have more than one. */
function steamBottles() {
  const names = bottleNames();
  return listBottles()
    .map((dir) => steamBottleIn(dir, names))
    .filter(Boolean);
}

/** The bottle an app's files live in, and its manifest if it has one. */
function bottleForApp(appid) {
  const bottles = steamBottles();

  for (const bottle of bottles) {
    const state = readManifests(bottle.dir).get(appid);
    if (state) return { bottle, state };
  }
  for (const bottle of bottles) {
    if (readOwnedLibrary(bottle.dir).has(appid)) return { bottle, state: null };
  }

  return { bottle: bottles[0] ?? null, state: null };
}

// Bumped whenever a cached field starts being worked out differently, so old
// values are dropped and fetched again rather than trusted.
const CACHE_VERSION = 2;
let heroAssetsPruned = false;

function loadNames() {
  let names;
  try {
    names = JSON.parse(readFileSync(NAME_CACHE, "utf8"));
  } catch {
    return { __v: CACHE_VERSION };
  }

  if (!names || typeof names !== "object") return { __v: CACHE_VERSION };

  if (names.__v !== CACHE_VERSION) {
    // Sizes and builds are derived from Steam's metadata; a rule change makes
    // the stored ones wrong, while names and types stay good.
    for (const key of Object.keys(names)) {
      if (key === "__v") continue;
      delete names[key].size;
      delete names[key].buildid;
      delete names[key].buildAt;
    }
    names.__v = CACHE_VERSION;
  }

  // The hero asset is no longer requested; stale copies are dropped on read so
  // the next write persists the smaller entry.
  for (const key of Object.keys(names)) {
    if (key === "__v") continue;
    if (names[key]?.assets?.hero) {
      delete names[key].assets.hero;
      heroAssetsPruned = true;
    }
  }

  return names;
}

function saveNames(names) {
  try {
    // The art lookup and the name lookup both edit this file. Merging into what
    // is on disk (a synchronous read-modify-write) keeps one worker's fresh
    // entries from being erased by the other's older snapshot.
    const disk = loadNames();

    for (const [id, entry] of Object.entries(names)) {
      if (id === "__v" || !entry || typeof entry !== "object") continue;
      const merged = { ...(disk[id] ?? {}), ...entry };
      if (merged.assets) {
        merged.assets = { ...merged.assets };
        delete merged.assets.hero;
      }
      disk[id] = merged;
    }

    disk.__v = CACHE_VERSION;
    mkdirSync(path.dirname(NAME_CACHE), { recursive: true });
    writeFileSync(NAME_CACHE, JSON.stringify(disk));
  } catch {
    // A cache we cannot write is not worth failing a request over.
  }
}

// Older caches still carry the hero URL this app no longer asks for. Reading
// strips it and records that it did, so one write removes it from disk instead
// of waiting for the next unrelated cache update.
const cachedNames = loadNames();
if (heroAssetsPruned) saveNames(cachedNames);

/**
 * Names and app types for apps that are not installed, which the local files
 * cannot tell us. Filled in the background and cached for a week, so the list
 * opens instantly and survives being offline.
 */
function lookupNames(ids) {
  const names = loadNames();
  const now = Date.now();

  for (const id of ids) {
    const entry = names[id];
    const ttl = entry?.name ? NAME_TTL : NAME_MISS_TTL;
    const fresh = entry && now - (entry.at ?? 0) <= ttl;
    // A miss recorded before the store and community fallbacks existed gets one
    // more look, then it is left alone until the normal retry window.
    const retry = entry?.unavailable === true && entry.retried !== true;
    if ((!fresh || retry) && !nameQueue.includes(id)) nameQueue.push(id);
  }

  pumpNames();
  return names;
}

/** The web API's app type enum: only 0 is a game. */
const APP_TYPES = new Map([
  [0, "game"],
  [1, "application"],
  [2, "tool"],
  [3, "demo"],
  [4, "media"],
  [5, "dlc"],
  [6, "video"],
  [7, "series"],
  [8, "music"],
  [9, "beta"],
  [10, "mod"],
  [11, "music"],
]);

/** Names for up to fifty apps in one call. Reports throttling separately. */
async function askBrowse(ids) {
  const input = JSON.stringify({
    ids: ids.map((id) => ({ appid: Number(id) })),
    context: { language: "english", country_code: "US", steam_realm: 1 },
    data_request: { include_basic_info: true, include_assets: true },
  });

  try {
    const response = await fetch(
      `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(input)}`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) },
    );

    if (response.status === 403 || response.status === 429) return { blocked: true };
    if (!response.ok) return { found: new Map() };

    const payload = await response.json();
    const found = new Map();

    // Delisted apps come back with success 15 but still carry their id, so the
    // response can always be matched without trusting its order.
    for (const item of payload?.response?.store_items ?? []) {
      const id = String(item?.id || item?.appid || "");
      if (!id || id === "0") continue;
      if (item.success !== 1 || !item.name) continue;

      const assets = item.assets ?? {};
      found.set(id, {
        name: item.name,
        type: APP_TYPES.get(item.type) ?? null,
        // Store art is addressed by a content hash now, so the old
        // /steam/apps/<id>/header.jpg paths no longer exist for new titles.
        assets: {
          header: assetUrl(assets, assets.header_2x ?? assets.header),
          capsule: assetUrl(
            assets,
            assets.library_capsule_2x ??
              assets.library_capsule ??
              assets.main_capsule_2x ??
              assets.main_capsule ??
              assets.header_2x ??
              assets.header,
          ),
        },
        assetsAt: Date.now(),
      });
    }

    return { found };
  } catch {
    return { found: new Map() };
  }
}

/**
 * Space an install needs, from the per-depot manifest sizes. Shared, language,
 * other-platform and DLC depots are skipped, so the number is what the base
 * game costs — which lands within a percent of what Steam reports on disk.
 */
function installSize(app) {
  let total = 0;

  for (const depot of Object.values(app?.depots ?? {})) {
    if (!depot || typeof depot !== "object") continue;
    if (depot.depotfromapp || depot.sharedinstall) continue;
    if (depot.dlcappid) continue;
    if (depot.config?.oslist && !/windows/i.test(depot.config.oslist)) continue;
    if (depot.config?.language) continue;
    total += Number(depot.manifests?.public?.size ?? 0);
  }

  return total || null;
}

/**
 * The store hides removed and unreleased apps, but the public app-info mirror
 * still knows their names — and their real type, which is how soundtracks and
 * test servers are told apart from games.
 */
async function askAppInfo(id) {
  try {
    const response = await fetch(`https://api.steamcmd.net/v1/info/${id}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;

    const payload = await response.json();
    const app = payload?.data?.[id];
    const common = app?.common;
    if (!common?.name) return null;

    const type = String(common.type ?? "").toLowerCase();
    return {
      name: common.name,
      type: type === "game" ? "game" : type || null,
      // Where Steam will put the files; an install cannot be queued without it.
      installdir: app?.config?.installdir ?? null,
      // The build the public branch is on, for the update check below.
      buildid: app?.depots?.branches?.public?.buildid ?? null,
      // Sum of the Windows content depots: the space an install will need.
      size: installSize(app),
    };
  } catch {
    return null;
  }
}

/**
 * The store's own details endpoint. It is a different service from the browse
 * one, and it still answers for apps the browse catalogue has dropped.
 */
async function askStoreName(id) {
  try {
    const response = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${id}&l=english&cc=US&filters=basic`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) return null;

    const entry = (await response.json())?.[id];
    if (!entry?.success || !entry.data?.name) return null;

    const type = String(entry.data.type ?? "").toLowerCase();
    return { name: entry.data.name, type: type === "game" ? "game" : type || null };
  } catch {
    return null;
  }
}

/**
 * The community hub still has a title for delisted games, which is the last
 * place a name can come from when both catalogues have forgotten an app.
 */
async function askCommunityName(id) {
  try {
    const response = await fetch(`https://steamcommunity.com/app/${id}/`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;

    const title = /<title>Steam Community :: ([^<]+)<\/title>/.exec(await response.text());
    if (!title) return null;

    const name = title[1].trim();
    if (!name || name === "Welcome to Steam" || name === "Steam Community") return null;
    return { name, type: null };
  } catch {
    return null;
  }
}

const ASSET_BASE = "https://shared.akamai.steamstatic.com/store_item_assets/";

/** Absolute URL for one file in a store item's asset bundle. */
function assetUrl(assets, file) {
  if (!assets?.asset_url_format || !file) return null;
  return ASSET_BASE + assets.asset_url_format.split("${FILENAME}").join(file);
}

/**
 * Artwork comes from the same catalogue call as the names, batched: a page of
 * library covers asks for dozens of images at once, and one request per image
 * would get this client throttled.
 */
const assetWaiters = [];
let assetTimer = null;

function ensureAssets(id) {
  return new Promise((resolve) => {
    assetWaiters.push({ id, resolve });
    if (!assetTimer) assetTimer = setTimeout(flushAssets, 80);
  });
}

async function flushAssets() {
  assetTimer = null;
  const waiters = assetWaiters.splice(0);
  const ids = [...new Set(waiters.map((waiter) => waiter.id))];
  const names = loadNames();
  const now = Date.now();
  const resolved = new Map();
  const missing = [];

  for (const id of ids) {
    const entry = names[id];
    if (entry?.assets?.header) resolved.set(id, entry.assets);
    else if (now - (entry?.assetsAt ?? 0) < NAME_MISS_TTL) resolved.set(id, entry?.assets ?? null);
    else missing.push(id);
  }

  try {
    for (let i = 0; i < missing.length; i += NAME_BATCH) {
      const slice = missing.slice(i, i + NAME_BATCH);
      const { blocked, found } = await askBrowse(slice);
      if (blocked) {
        for (const id of slice) resolved.set(id, names[id]?.assets ?? null);
        continue;
      }

      for (const id of slice) {
        const entry = names[id] ?? {};
        const meta = found.get(id);
        if (meta) Object.assign(entry, meta);
        // Record the miss too, so a delisted app is not asked for again on
        // every image request.
        entry.assetsAt = now;
        names[id] = entry;
        resolved.set(id, entry.assets ?? null);
      }
    }

    if (missing.length) saveNames(names);
  } catch {
    // The caller falls back to local art rather than failing the image.
  } finally {
    for (const waiter of waiters) waiter.resolve(resolved.get(waiter.id) ?? null);
  }
}

async function pumpNames() {
  if (namesRunning || !nameQueue.length) return;
  namesRunning = true;

  const names = loadNames();

  try {
    while (nameQueue.length) {
      const batch = [];
      while (nameQueue.length && batch.length < NAME_BATCH) {
        const id = nameQueue.shift();
        if (!names[id]?.name) batch.push(id);
      }
      if (!batch.length) break;

      const { blocked, found } = await askBrowse(batch);

      if (blocked) {
        const tries = (nameAttempts.get("batch") ?? 0) + 1;
        nameAttempts.set("batch", tries);
        nameQueue.unshift(...batch);
        if (tries > 4) break;
        await sleep(Math.min(60_000 * tries, 300_000));
        continue;
      }

      nameAttempts.delete("batch");
      for (const [id, meta] of found) names[id] = { ...meta, at: Date.now() };
      saveNames(names);

      for (const id of batch) {
        if (names[id]?.name) continue;

        // The mirror occasionally times out under a burst; one retry is enough.
        let meta = await askAppInfo(id);
        if (!meta) {
          await sleep(600);
          meta = await askAppInfo(id);
        }

        // Delisted and unlisted apps fall out of the catalogue the client uses,
        // so two other sources are asked before an owned app is reduced to a
        // bare appid.
        if (!meta) meta = await askStoreName(id);
        if (!meta) meta = await askCommunityName(id);

        // Nothing public names it and the store won't show it: a depot id or a
        // removed entry, not something this account can install.
        names[id] = meta
          ? { ...meta, at: Date.now() }
          : { name: null, type: null, unavailable: true, retried: true, at: Date.now() };
        saveNames(names);
        await sleep(400);
      }

      await sleep(400);
    }

    saveNames(names);
  } finally {
    namesRunning = false;
  }
}

/**
 * A finished install keeps Steam's final byte counters, so counters alone do
 * not mean a download is running. An update is in flight only while the bytes
 * sit below their total or the staging folder exists: the "update required"
 * flag says Steam owes an update, not that one is moving.
 */
export function updateInFlight(state) {
  if (!state || (state.state & 4) === 0) return false;

  if (state.download > 0 && (state.downloadTotal === 0 || state.download < state.downloadTotal)) {
    return true;
  }
  if (state.staged > 0 && (state.stageTotal === 0 || state.staged < state.stageTotal)) return true;

  return Boolean(state.library) && hasEntries(path.join(state.library, "downloading", state.appid));
}

/* ---------------- update checks ---------------- */

const BUILD_TTL = 6 * 60 * 60 * 1000;
const buildQueue = [];
let buildsRunning = false;

/**
 * Steam only knows a game is stale by comparing the build the store publishes
 * with the one in its manifest, and a windowless client shows nobody that
 * comparison. Both numbers are kept here, refreshed for installed games and
 * cached, so the library can flag the ones that are behind.
 */
function refreshBuilds(ids) {
  const names = loadNames();
  const now = Date.now();
  let waiting = 0;

  for (const id of ids) {
    const entry = names[id];
    if (!entry?.name) continue;
    if (now - (entry.buildAt ?? 0) < BUILD_TTL) continue;

    waiting += 1;
    if (!buildQueue.includes(id)) buildQueue.push(id);
  }

  pumpBuilds();
  return waiting;
}

async function pumpBuilds() {
  if (buildsRunning || !buildQueue.length) return;
  buildsRunning = true;

  try {
    while (buildQueue.length) {
      const id = buildQueue.shift();
      const meta = await askAppInfo(id);

      const names = loadNames();
      if (names[id]) {
        // A failed check still stamps the attempt, so one unreachable app does
        // not get asked again on every library read.
        names[id] = {
          ...names[id],
          ...(meta?.buildid ? { buildid: meta.buildid } : {}),
          buildAt: Date.now(),
        };
        saveNames(names);
      }

      await sleep(400);
    }
  } finally {
    buildsRunning = false;
  }
}

function librarySnapshot(names) {
  const bottles = steamBottles();
  const ownedIds = new Set();
  const pendingIds = new Set();
  const rows = new Map();
  const extras = new Map();

  for (const bottle of bottles) {
    const library = readOwnedLibrary(bottle.dir);
    const manifests = readManifests(bottle.dir);

    for (const { appid, art } of library.values()) {
      ownedIds.add(appid);

      const state = manifests.get(appid);
      const installed = Boolean(state && (state.state & 4) !== 0);

      // The same app can be cached in more than one bottle. The installed copy
      // wins; otherwise the first bottle that has it wins.
      const previous = rows.get(appid) ?? extras.get(appid);
      if (previous?.installed) continue;
      if (previous && !installed) continue;

      const meta = names?.[appid] ?? {};
      const type = meta.type ?? (state ? "game" : null);

      // Tools, dedicated servers, soundtracks and demos share the library cache
      // with games. They are owned, so they are counted and can be inspected,
      // but they are not rows to launch: they are listed as extras instead of
      // being dropped on the floor.
      if (type && type !== "game" && !installed) {
        rows.delete(appid);
        extras.set(appid, {
          appid,
          name: meta.name ?? null,
          type,
          installed,
          bottle: bottle.name,
        });
        continue;
      }
      // An id no catalogue names. It may be a depot — or a game Steam delisted.
      if (!meta.name && meta.unavailable && !state) {
        extras.set(appid, {
          appid,
          name: null,
          type: null,
          installed: false,
          unidentified: true,
          bottle: bottle.name,
        });
        continue;
      }

      if (!meta.name && !state) pendingIds.add(appid);

      const build = Number(meta.buildid ?? 0);
      const local = Number(state?.buildid ?? 0);
      const updating = updateInFlight(state);
      // A newer public build than the manifest's: with no client window this is
      // the only place that difference can be shown.
      const updateAvailable = installed && !updating && build > local;

      extras.delete(appid);
      rows.set(appid, {
        appid,
        name: meta.name ?? (installed ? state.name : null),
        type,
        bottle: bottle.name,
        installed,
        updating,
        downloading: Boolean(state) && !installed,
        updateAvailable,
        buildid: local || null,
        updateBuild: build || null,
        sizeOnDisk: installed ? state.sizeOnDisk : null,
        // Known only once the metadata cache has seen this app, so the client
        // treats it as a hint rather than a promise.
        installSize: installed ? null : (meta.size ?? null),
        // The art route can fetch a cover Steam never cached locally, so every
        // catalogue entry gets the URL; the client shows initials on a 404.
        art: `/api/library-art?appid=${appid}`,
      });
    }
  }

  const games = [...rows.values()];
  games.sort(
    (a, b) =>
      Number(b.installed) - Number(a.installed) ||
      Number(b.downloading) - Number(a.downloading) ||
      Number(Boolean(b.name)) - Number(Boolean(a.name)) ||
      (a.name ?? `App ${a.appid}`).localeCompare(b.name ?? `App ${b.appid}`),
  );

  const extraList = [...extras.values()];
  extraList.sort(
    (a, b) =>
      Number(b.installed) - Number(a.installed) ||
      Number(Boolean(b.name)) - Number(Boolean(a.name)) ||
      (a.name ?? `App ${a.appid}`).localeCompare(b.name ?? `App ${b.appid}`),
  );

  const checking = refreshBuilds(games.filter((game) => game.installed).map((game) => game.appid));

  return {
    bottle: bottles[0]?.name ?? null,
    bottles: bottles.map((bottle) => bottle.name),
    steamInstalled: steamInstallBottles().length,
    owned: ownedIds.size,
    pending: pendingIds.size,
    checking,
    extras: { count: extraList.length, items: extraList },
    games,
  };
}

/* ---------------- hover clips ---------------- */

// The store only advertises DASH/HLS manifests now, which a WKWebView cannot
// play, so a short muted slice of the store trailer is remuxed to mp4 once per
// game and cached. Hovering again is instant, and it works offline afterwards.
const CLIP_DIR = path.join(homedir(), "Library", "Caches", "MacForge", "clips");
const CLIP_INDEX = path.join(homedir(), "Library", "Caches", "MacForge", "clips.json");
const ART_DIR = path.join(homedir(), "Library", "Caches", "MacForge", "art");
const CLIP_SECONDS = 12;

/**
 * A library cover for one app, downloaded once and kept. Covers change rarely;
 * deleting the file is enough to pick a new one up.
 */
async function artworkFor(appid, shape = "capsule") {
  const file = path.join(ART_DIR, shape === "header" ? `${appid}-header.jpg` : `${appid}.jpg`);
  if (existsSync(file)) return file;

  const assets = await ensureAssets(appid);
  const remote = shape === "header" ? assets?.header : assets?.capsule;
  if (!remote) return null;

  try {
    const response = await fetch(remote, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) return null;
    mkdirSync(ART_DIR, { recursive: true });
    writeFileSync(file, bytes);
    return file;
  } catch {
    return null;
  }
}
const CLIP_MISS_TTL = 6 * 60 * 60 * 1000;

const clipJobs = new Map();

/** ffmpeg is not on a GUI app's PATH, so look where Homebrew puts it. */
function findTool(name) {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const FFMPEG = findTool("ffmpeg");
const FFPROBE = findTool("ffprobe");

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * How much space an install is short by, with a small margin for Steam's own
 * staging. Zero when the size is unknown or there is room enough.
 */
export function spaceShortfall(needed, free) {
  if (!needed || free === null || free === undefined) return 0;
  return Math.max(0, needed * 1.02 + 512 * 1024 * 1024 - free);
}

/** Free and total space on the volume a bottle sits on. */
function diskSpace(dir) {
  try {
    const stats = statfsSync(dir);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

/**
 * What has to be on this Mac before the app can do its job. Only failures are
 * worth showing, but every check reports its detail so the panel can explain
 * what it found rather than just what is wrong.
 */
function preflight() {
  const bottles = steamBottles();
  const steamInstalls = steamInstallBottles();
  const wine = wineRuntime();
  const trailers = Boolean(FFMPEG && FFPROBE);
  const disk = bottles[0] ? diskSpace(bottles[0].dir) : null;
  const space = disk ? disk.free : null;

  const source = { own: "this app's own copy", override: "WHISKY_GAMES_WINE", shared: "shared copy" };

  const checks = [
    {
      id: "wine",
      label: "Wine runtime",
      ok: wine.ok,
      detail: wine.ok
        ? `${wine.version ?? "Wine"} · ${source[wine.source] ?? wine.source}`
        : "No Wine runtime found",
      fix: wine.ok
        ? null
        : "node scripts/fetch-runtime.mjs — installs a Wine this app owns",
    },
    {
      id: "trailers",
      label: "Trailers",
      ok: trailers,
      detail: trailers
        ? `ffmpeg in ${path.dirname(FFMPEG)}`
        : "ffmpeg is missing, so store trailers cannot be prepared",
      fix: trailers ? null : "brew install ffmpeg",
    },
    {
      id: "steam",
      label: "Steam bottle",
      ok: steamInstalls.length > 0,
      detail: steamInstalls.length
        ? steamInstalls.map((bottle) => bottle.name).join(" · ")
        : "No bottle has a Steam install",
      // The setup card directly below is the fix; no terminal step to copy.
      action: steamInstalls.length ? null : "steam-setup",
    },
    {
      id: "disk",
      label: "Disk space",
      ok: space === null || space > 15e9,
      detail: space === null ? "Unknown" : `${gb(space)} free`,
      fix: space !== null && space <= 15e9 ? "Free up space before installing a game" : null,
    },
    {
      id: "node",
      label: "Node",
      ok: true,
      detail: `${process.version} · ${path.basename(process.execPath)}`,
      fix: null,
    },
  ];

  // Deliberately not called "ok": the envelope's ok means the request worked,
  // while this says whether the machine is set up.
  return { healthy: checks.every((check) => check.ok), checks, disk };
}

function runTool(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const tail = String(stderr || error.message).trim().split("\n").filter(Boolean).slice(-1)[0];
      reject(new Error(tail ?? error.message));
    });
  });
}

function loadClips() {
  try {
    return JSON.parse(readFileSync(CLIP_INDEX, "utf8"));
  } catch {
    return {};
  }
}

function saveClips(clips) {
  try {
    mkdirSync(path.dirname(CLIP_INDEX), { recursive: true });
    writeFileSync(CLIP_INDEX, JSON.stringify(clips));
  } catch {
    // A cache we cannot write is not worth failing a request over.
  }
}

const clipPath = (appid) => path.join(CLIP_DIR, `${appid}.mp4`);

/** The trailer the store page leads with, or the first one it has. */
async function askMovie(appid) {
  const response = await fetch(
    `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=movies&l=english&cc=US`,
    { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`store answered ${response.status}`);

  const json = await response.json();
  const movies = json?.[appid]?.data?.movies ?? [];
  return movies.find((movie) => movie.highlight) ?? movies[0] ?? null;
}

/** Lowest-bandwidth HLS rendition that still looks right in a small preview. */
function pickVariant(master, base) {
  const lines = master.split("\n").map((line) => line.trim());
  const options = [];

  for (let i = 0; i < lines.length; i += 1) {
    const info = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]);
    if (!info) continue;

    const next = lines[i + 1];
    if (!next || next.startsWith("#")) continue;

    options.push({
      bandwidth: Number(/BANDWIDTH=(\d+)/.exec(info[1])?.[1] ?? 0),
      width: Number(/RESOLUTION=(\d+)x\d+/.exec(info[1])?.[1] ?? 0),
      url: new URL(next, base).href,
    });
  }

  options.sort((a, b) => a.bandwidth - b.bandwidth);
  return options.find((option) => option.width >= 640) ?? options[0] ?? null;
}

async function makeClip(appid, movie) {
  if (!movie.hls_h264) throw new Error("no trailer stream");

  const master = await fetch(movie.hls_h264, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  const variant = pickVariant(await master.text(), movie.hls_h264);
  if (!variant) throw new Error("no trailer rendition");

  const duration = Number((await runTool(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", variant.url,
  ], 45_000)).trim());
  if (!Number.isFinite(duration) || duration < 3) throw new Error("unreadable trailer");

  // Twelve seconds from a fifth of the way in: past the logos, into the game.
  const length = Math.min(CLIP_SECONDS, Math.max(4, duration * 0.6));
  const start = Math.max(0, Math.min(duration * 0.2, duration - length - 0.5));

  mkdirSync(CLIP_DIR, { recursive: true });
  const temp = path.join(CLIP_DIR, `${appid}.part.mp4`);
  await runTool(FFMPEG, [
    "-nostdin", "-y",
    "-ss", start.toFixed(2),
    "-i", variant.url,
    "-t", length.toFixed(2),
    "-an", "-c", "copy", "-movflags", "+faststart",
    temp,
  ], 180_000);

  renameSync(temp, clipPath(appid));
}

/** Where a game's clip is, building it on first hover. */
async function clipFor(appid) {
  const clips = loadClips();
  const cached = clips[appid];

  if (existsSync(clipPath(appid))) {
    return {
      appid,
      url: `/api/clip-file?appid=${appid}`,
      poster: cached?.poster ?? null,
      title: cached?.title ?? null,
    };
  }

  if (cached?.miss && Date.now() - (cached.at ?? 0) < CLIP_MISS_TTL) {
    return { appid, url: null, error: cached.error ?? "no trailer" };
  }

  if (clipJobs.has(appid)) return clipJobs.get(appid);

  const job = (async () => {
    const movie = await askMovie(appid);

    if (!movie) {
      clips[appid] = { at: Date.now(), miss: true, error: "no trailer" };
      saveClips(clips);
      return { appid, url: null, error: "no trailer" };
    }

    const meta = { at: Date.now(), title: movie.name ?? null, poster: movie.thumbnail ?? null };

    // Without ffmpeg the manifest is the best we can do; the app's own web
    // view may still play it directly.
    if (!FFMPEG || !FFPROBE) {
      clips[appid] = meta;
      saveClips(clips);
      return {
        appid,
        url: movie.hls_h264 ?? movie.dash_h264 ?? null,
        poster: meta.poster,
        title: meta.title,
        remote: true,
      };
    }

    try {
      await makeClip(appid, movie);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      clips[appid] = { at: Date.now(), miss: true, error: reason };
      saveClips(clips);
      return { appid, url: null, error: reason };
    }

    clips[appid] = meta;
    saveClips(clips);
    return { appid, url: `/api/clip-file?appid=${appid}`, poster: meta.poster, title: meta.title };
  })();

  clipJobs.set(appid, job);
  try {
    return await job;
  } finally {
    clipJobs.delete(appid);
  }
}

/* ---------------- downloads ---------------- */

const installJobs = new Map();
let installCounter = 0;

// Speeds are measured from the byte counters themselves: no Steam window means
// no other honest source for them.
const downloadSpeeds = new Map();
const downloadPeaks = new Map();
// Downloads this app stopped on purpose, so their rows say paused rather than
// "downloading at 0 B/s". Steam's own state has no pause bit to read.
const pausedDownloads = new Map();

function sampleSpeed(appid, done) {
  const now = Date.now();
  const previous = downloadSpeeds.get(appid);

  if (!previous) {
    downloadSpeeds.set(appid, { done, at: now, speed: 0 });
    return 0;
  }

  const span = now - previous.at;
  if (span < 2_500) return previous.speed;

  const instant = Math.max(0, ((done - previous.done) * 1000) / span);
  // Steam writes its counters in bursts, so a single gap is not a real speed.
  const speed = previous.speed > 0 ? previous.speed * 0.65 + instant * 0.35 : instant;
  downloadSpeeds.set(appid, { done, at: now, speed });
  return speed;
}

function hasEntries(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function directorySize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(full);
      else if (entry.isFile()) total += statSync(full).size;
    } catch {
      // A file that vanished mid-walk is already gone.
    }
  }

  return total;
}

/** Steam's own evidence that a download has started, with no window to ask. */
function downloadStarted(bottleDir, appid, log, since, { ignoreInstalled = false } = {}) {
  const state = readManifests(bottleDir).get(appid);

  if (state) {
    // An installed app is "done" by definition, so an update has to look past
    // the flag and find bytes actually moving.
    if (!ignoreInstalled && (state.state & 4) !== 0) return true;
    if (
      state.downloadTotal > 0 ||
      state.download > 0 ||
      state.stageTotal > 0 ||
      state.staged > 0
    ) {
      return true;
    }
    if (hasEntries(path.join(state.library, "downloading", appid))) return true;
  }

  if (!log || !existsSync(log)) return false;

  let text;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return false;
  }

  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const stamp = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(line);
    if (!stamp) continue;
    if (stamp[1] < since) break;
    if (line.includes(`AppID ${appid}`) && /update started|download/i.test(line)) return true;
  }

  return false;
}

/**
 * How Steam is asked to download without ever showing its window.
 *
 * `steam://install/<appid>` opens the client's Install dialog and waits for a
 * click, which is exactly what this app must not do. Instead the library gets a
 * pending manifest — the same state Steam writes itself when an install is
 * missing files — and the silenced client downloads it on its next scan.
 */

/** Where Steam wants the app, from the public app-info mirror. */
async function installTarget(appid) {
  const cached = loadNames()[appid];
  // The size is needed for the free-space check even when the folder is known.
  if (cached?.name && cached?.installdir && cached?.size) return cached;

  const fresh = await askAppInfo(appid);
  if (!fresh) return cached?.name ? cached : null;

  const merged = {
    ...cached,
    ...fresh,
    installdir: fresh.installdir ?? cached?.installdir ?? null,
    size: fresh.size ?? cached?.size ?? null,
  };

  if (fresh.installdir || fresh.size) {
    const names = loadNames();
    names[appid] = { ...names[appid], ...merged, at: names[appid]?.at ?? Date.now() };
    saveNames(names);
  }

  return merged;
}

/** The account that owns the library, copied from a manifest Steam wrote. */
function lastOwner(bottle) {
  for (const entry of readManifests(bottle.dir).values()) {
    try {
      const owner = /"LastOwner"\s+"(\d+)"/.exec(readFileSync(entry.file, "utf8"));
      if (owner) return owner[1];
    } catch {
      // A manifest mid-write is skipped; the next one will do.
    }
  }
  return null;
}

/** A minimal manifest with Update Required set: Steam fills in the rest. */
function queueManifest(bottle, appid, meta) {
  const library = path.join(bottle.steam, "steamapps");
  const owner = lastOwner(bottle);
  const quote = (value) => String(value).replace(/["\r\n]/g, "").trim();

  const lines = [
    '"AppState"',
    "{",
    `\t"appid"\t\t"${appid}"`,
    '\t"Universe"\t\t"1"',
    `\t"name"\t\t"${quote(meta.name)}"`,
    // 2 = Update Required: the client's own scheduler takes it from here.
    '\t"StateFlags"\t\t"2"',
    `\t"installdir"\t\t"${quote(meta.installdir)}"`,
    '\t"LastUpdated"\t\t"0"',
    '\t"LastPlayed"\t\t"0"',
    '\t"SizeOnDisk"\t\t"0"',
    '\t"StagingSize"\t\t"0"',
    '\t"buildid"\t\t"0"',
    ...(owner ? [`\t"LastOwner"\t\t"${owner}"`] : []),
    '\t"UpdateResult"\t\t"0"',
    '\t"BytesToDownload"\t\t"0"',
    '\t"BytesDownloaded"\t\t"0"',
    '\t"BytesToStage"\t\t"0"',
    '\t"BytesStaged"\t\t"0"',
    '\t"TargetBuildID"\t\t"0"',
    '\t"AutoUpdateBehavior"\t\t"0"',
    '\t"AllowOtherDownloadsWhileRunning"\t\t"0"',
    '\t"ScheduledAutoUpdate"\t\t"0"',
    "}",
    "",
  ];

  const file = path.join(library, `appmanifest_${appid}.acf`);
  writeFileSync(file, lines.join("\n"));
  return file;
}

/** Drop a queued manifest that never turned into a real download. */
function clearPendingManifest(bottle, appid) {
  const state = readManifests(bottle.dir).get(appid);
  if (!state) return;

  const untouched =
    (state.state & 4) === 0 &&
    state.downloadTotal === 0 &&
    state.download === 0 &&
    state.staged === 0 &&
    !hasEntries(path.join(state.library, "downloading", appid));
  if (!untouched) return;

  try {
    rmSync(state.file, { force: true });
  } catch {
    // Nothing to clean up then.
  }
}

async function runInstall(job, appid, bottle, known) {
  const log = steamBottleLog();

  try {
    job.state = "steam";
    job.detail = "Preparing the download";

    if (runningState().games.length > 0) {
      throw new Error("Close the running game first — Steam can't queue a download while it plays");
    }

    const meta = known ?? (await installTarget(appid));
    if (!meta?.installdir) throw new Error("Steam doesn't say where this app installs");

    queueManifest(bottle, appid, meta);

    // The silenced client only scans its library at startup, and has no window
    // in this mode either way.
    for (const dir of listBottles()) await stopBottle(dir);
    await sleep(2_000);

    const since = stampNow();
    spawnDetached(["run", bottle.name, bottle.exe, "--", "-silent"]);

    job.state = "waiting";
    job.detail = "Waiting for Steam";

    if (!(await waitFor(steamRunning, 90_000, 700))) {
      throw new Error("Steam didn't start in the bottle");
    }
    // Same cold-boot budget as a launch: Steam may verify its installation first.
    await waitFor(() => steamReadySince(log, since), 300_000, 700);

    const started = await waitFor(
      () => downloadStarted(bottle.dir, appid, log, since),
      120_000,
      1_000,
    );
    if (!started) throw new Error("Steam didn't pick the download up");

    job.state = "downloading";
    job.detail = "Downloading";
    job.finishedAt = Date.now();
  } catch (error) {
    clearPendingManifest(bottle, appid);
    job.state = "error";
    job.detail = error instanceof Error ? error.message : String(error);
  } finally {
    setTimeout(() => installJobs.delete(job.id), 900_000).unref?.();
  }
}

/* ---------------- first-run Steam setup ---------------- */

// The official bootstrapper both CDNs serve; the second is the fallback when
// one edge is unreachable. It is small — Steam downloads itself afterwards.
const STEAM_SETUP_URLS = [
  "https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe",
  "https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe",
];

let steamSetupJob = null;

async function downloadSteamSetup(file) {
  let lastError = null;
  for (const url of STEAM_SETUP_URLS) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      if (statSync(file).size < 1_000_000) throw new Error("the installer is too small");
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not download SteamSetup.exe — ${lastError?.message ?? "unknown error"}`);
}

/** Where SteamSetup put steam.exe, as a Windows path Wine can launch. */
function installedSteamExe(prefix) {
  if (existsSync(path.join(prefix, "drive_c/Program Files (x86)/Steam/Steam.exe"))) {
    return STEAM_EXES[0];
  }
  if (existsSync(path.join(prefix, "drive_c/Program Files/Steam/Steam.exe"))) {
    return STEAM_EXES[1];
  }
  return null;
}

/** Bottles that have Steam installed, even before its first window writes appcache. */
function steamInstallBottles() {
  return listBottles()
    .map((dir) => {
      const exe = installedSteamExe(dir);
      return exe ? { dir, exe, name: path.basename(dir) } : null;
    })
    .filter(Boolean);
}

/** "Steam", then "Steam 2" if that name is already taken by another bottle. */
function steamSetupBottleName() {
  for (let n = 0; ; n += 1) {
    const name = n === 0 ? "Steam" : `Steam ${n + 1}`;
    if (!existsSync(path.join(OWN_BOTTLES, name))) return name;
  }
}

/**
 * Build the bottle, install Steam into it silently, give it the DLL payloads a
 * game needs, and open Steam once so its sign-in window appears. Steam's own
 * client update runs on that first window, so the user sees a normal login.
 */
async function runSteamSetup(job) {
  let dir = null;
  let createdBottle = false;

  try {
    job.state = "runtime";
    job.detail = "Waiting for the Wine runtime";
    const deadline = Date.now() + 20 * 60_000;
    while (!wineRuntime(true).ok) {
      if (Date.now() > deadline) {
        throw new Error("Wine is not ready yet — wait for its download to finish, then try again");
      }
      await sleep(3_000);
    }

    job.state = "bottle";
    const name = steamSetupBottleName();
    dir = path.join(OWN_BOTTLES, name);
    createdBottle = true;
    job.detail = `Creating the ${name} bottle`;

    const made = await makeBottle(dir);
    if (!made.ok) throw new Error(made.error || "Wine could not create a bottle");

    job.state = "installer";
    job.detail = "Downloading the Steam installer";
    const downloads = path.join(dir, "drive_c", "MacForge");
    mkdirSync(downloads, { recursive: true });
    const installer = path.join(downloads, "SteamSetup.exe");
    await downloadSteamSetup(installer);

    job.state = "installing";
    job.detail = "Installing Steam — this takes a few minutes";
    const result = await wineRun(dir, "C:\\MacForge\\SteamSetup.exe", ["/S"], 900_000);

    // The silent installer can return just before its files are all on disk.
    let steamExe = installedSteamExe(dir);
    for (let attempt = 0; !steamExe && attempt < 90; attempt += 1) {
      await sleep(2_000);
      steamExe = installedSteamExe(dir);
    }
    if (!steamExe) {
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 240);
      throw new Error(detail || "SteamSetup finished without writing Steam.exe");
    }
    rmSync(downloads, { recursive: true, force: true });

    job.state = "preparing";
    job.detail = "Preparing DirectX for your games";
    try {
      await prepareBottle(dir);
    } catch {
      // A payload problem must not hide a working Steam install.
    }

    job.state = "launching";
    job.detail = "Opening Steam";
    const pid = wineLaunch(dir, steamExe);
    if (!pid) throw new Error("Steam is installed, but Wine could not open it");

    job.state = "done";
    job.detail = "Steam is open. Sign in there once — your games will appear here.";
  } catch (error) {
    // A half-built bottle is not worth retrying with: remove it, so the next
    // attempt is "Steam" again instead of "Steam 2". A bottle where Steam is
    // already installed is kept — retrying there just reopens Steam.
    if (createdBottle && dir && existsSync(dir) && !installedSteamExe(dir)) {
      await stopBottle(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    job.state = "error";
    job.detail = error instanceof Error ? error.message : String(error);
  } finally {
    steamSetupJob = null;
    setTimeout(() => jobs.delete(job.id), 900_000).unref?.();
  }
}

/**
 * Whether there is really a download or update running for this app. An
 * installed app is judged by the same evidence as the progress bar, because
 * its manifest keeps the counters of the install that already finished.
 */
export function activeDownload(state) {
  if (!state) return false;
  if ((state.state & 4) !== 0) return updateInFlight(state);
  if (state.download > 0 || state.staged > 0 || state.stageTotal > 0) return true;
  return hasEntries(path.join(state.library, "downloading", state.appid));
}

/**
 * Cancelling removes the partial download the way Steam does it: the staging
 * folder, anything already committed, the shadercache and the manifest.
 * Everything is resolved from disk, never from the request.
 */
async function cancelDownload(appid, state) {
  if (runningState().games.length > 0) {
    return { status: 409, body: { ok: false, error: "Close the running game first" } };
  }

  const common = path.resolve(state.library, "common");
  const target = state.installdir ? path.resolve(common, state.installdir) : "";
  if (target && target !== common && !target.startsWith(`${common}${path.sep}`)) {
    return {
      status: 400,
      body: { ok: false, error: "That app's install folder looks unsafe to remove" },
    };
  }

  for (const dir of listBottles()) await stopBottle(dir);
  await sleep(1_200);

  const staging = path.join(state.library, "downloading", appid);
  let freed = 0;

  try {
    // Steam preallocates staging files to their full size, so only the blocks
    // actually written count as space this gave back.
    freed = directoryBlocks(staging);
    rmSync(staging, { recursive: true, force: true });
    rmSync(state.file, { force: true });
    rmSync(path.join(state.library, "shadercache", appid), { recursive: true, force: true });
    if (target && existsSync(target)) {
      freed += directorySize(target);
      rmSync(target, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        error: `Couldn't cancel it cleanly — ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  pausedDownloads.delete(appid);
  downloadSpeeds.delete(appid);
  downloadPeaks.delete(appid);
  stagedSizes.delete(appid);
  for (const job of installJobs.values()) {
    if (job.appid === appid) installJobs.delete(job.id);
  }

  return { status: 200, body: { ok: true, appid, name: state.name, freed } };
}

/**
 * Pausing is stopping the client: Steam keeps its staging folder and continues
 * from it the next time it starts. That is the only pause a windowless client
 * can offer, and resuming is exactly the opposite half of the same move.
 */
function startResume(appid, bottle) {
  installCounter += 1;
  const job = {
    id: `d${Date.now().toString(36)}${installCounter}`,
    appid,
    state: "waiting",
    detail: "Starting Steam",
    startedAt: Date.now(),
  };
  installJobs.set(job.id, job);

  runResume(job, appid, bottle);
  return job;
}

async function runResume(job, appid, bottle) {
  const log = steamBottleLog();

  try {
    const installed = Boolean(readManifests(bottle.dir).get(appid)?.state & 4);
    const since = stampNow();
    spawnDetached(["run", bottle.name, bottle.exe, "--", "-silent"]);

    job.state = "waiting";
    job.detail = "Waiting for Steam";
    if (!(await waitFor(steamRunning, 90_000, 700))) {
      throw new Error("Steam didn't start in the bottle");
    }

    // Same cold-boot budget as a launch: Steam may verify its installation first.
    await waitFor(() => steamReadySince(log, since), 300_000, 700);

    job.detail = "Picking the download back up";
    const started = await waitFor(
      () => downloadStarted(bottle.dir, appid, log, since, { ignoreInstalled: installed }),
      150_000,
      1_000,
    );
    if (!started) throw new Error("Steam didn't pick the download back up");

    job.state = "downloading";
    job.detail = installed ? "Updating" : "Downloading";
  } catch (error) {
    pausedDownloads.set(appid, Date.now());
    job.state = "error";
    job.detail = error instanceof Error ? error.message : String(error);
  } finally {
    setTimeout(() => installJobs.delete(job.id), 900_000).unref?.();
  }
}

/**
 * A pending update is Steam's own flag: StateFlags gains Update Required (2)
 * while Fully Installed (4) stays set, so the client updates the game in place
 * on its next scan instead of reinstalling it.
 *
 * Only those two fields are touched. Everything else in the manifest — the
 * install folder, the build, the counters Steam wrote — is left exactly as it
 * was, because Steam reads this file back on its next start.
 */
export function flagManifestForUpdate(raw) {
  const flags = /"StateFlags"\s+"(\d+)"/.exec(raw);
  if (!flags) return null;

  const previous = Number(flags[1]);
  let text = raw.replace(/"StateFlags"\s+"\d+"/, `"StateFlags"\t\t"${previous | 2}"`);
  if (/"UpdateResult"\s+"\d+"/.test(text)) {
    text = text.replace(/"UpdateResult"\s+"\d+"/, '"UpdateResult"\t\t"0"');
  }

  return { text, previous };
}

/** The surgical undo: the flag goes back, anything Steam wrote stays. */
export function restoreManifestFlags(raw, previous) {
  return raw.replace(/"StateFlags"\s+"\d+"/, `"StateFlags"\t\t"${previous}"`);
}

function markUpdate(bottle, appid) {
  const state = readManifests(bottle.dir).get(appid);
  if (!state) return null;

  let raw;
  try {
    raw = readFileSync(state.file, "utf8");
  } catch {
    return null;
  }

  const flagged = flagManifestForUpdate(raw);
  if (!flagged) return null;

  try {
    writeFileSync(state.file, flagged.text);
  } catch {
    return null;
  }

  return { file: state.file, previous: flagged.previous };
}

/** A manifest left flagged for an update Steam ignored is put back as it was. */
function restoreFlags(marked) {
  if (!marked) return;
  try {
    const raw = readFileSync(marked.file, "utf8");
    writeFileSync(marked.file, restoreManifestFlags(raw, marked.previous));
  } catch {
    // The manifest is Steam's to rewrite; a failed rollback is not fatal.
  }
}

function startUpdate(appid, bottle, mode = "update") {
  installCounter += 1;
  const job = {
    id: `u${Date.now().toString(36)}${installCounter}`,
    appid,
    mode,
    state: "steam",
    detail: mode === "verify" ? "Checking the files" : "Checking for the update",
    startedAt: Date.now(),
  };
  installJobs.set(job.id, job);

  runUpdate(job, appid, bottle, mode);
  return job;
}

async function runUpdate(job, appid, bottle, mode = "update") {
  const log = steamBottleLog();
  const verifying = mode === "verify";
  let marked = null;

  try {
    // Steam rewrites manifests on shutdown, so the flag goes in once it is off.
    job.state = "steam";
    job.detail = "Getting Steam ready";
    for (const dir of listBottles()) await stopBottle(dir);
    await sleep(2_000);

    marked = markUpdate(bottle, appid);
    if (!marked) throw new Error("Steam's manifest for that game looked unreadable");

    const since = stampNow();
    const startedAt = Date.now();
    const flagged = () => ((readManifests(bottle.dir).get(appid)?.state ?? 0) & 2) !== 0;

    spawnDetached(["run", bottle.name, bottle.exe, "--", "-silent"]);

    job.state = "waiting";
    job.detail = "Waiting for Steam";
    if (!(await waitFor(steamRunning, 90_000, 700))) {
      throw new Error("Steam didn't start in the bottle");
    }
    // Same cold-boot budget as a launch: Steam may verify its installation first.
    await waitFor(() => steamReadySince(log, since), 300_000, 700);

    job.detail = verifying ? "Verifying files" : "Updating";

    // Two endings are honest: bytes start moving, or Steam clears the flag
    // having found nothing to do. The grace period stops Steam's own startup
    // rewrite of the manifest being mistaken for a finished check.
    const moved = () => downloadStarted(bottle.dir, appid, log, since, { ignoreInstalled: true });
    const settled = () => !flagged() && Date.now() - startedAt > 5_000;
    await waitFor(() => moved() || settled(), 240_000, 1_000);

    if (moved()) {
      job.state = "downloading";
      job.detail = verifying ? "Repairing" : "Updating";
    } else if (!flagged()) {
      job.state = "done";
      job.detail = verifying ? "Every file checked out" : "Already up to date";
    } else {
      throw new Error(verifying ? "Steam didn't start checking the files" : "Steam didn't start the update");
    }
  } catch (error) {
    restoreFlags(marked);
    job.state = "error";
    job.detail = error instanceof Error ? error.message : String(error);
  } finally {
    setTimeout(() => installJobs.delete(job.id), 900_000).unref?.();
  }
}

/**
 * Totals for each app's current download pass. Steam logs them once, up front,
 * and never repeats them, which is the only place the full size is known.
 */
function downloadTotals(log) {
  const totals = new Map();
  if (!log || !existsSync(log)) return totals;

  let text;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return totals;
  }

  const pattern = /AppID (\d+) update started : download \d+\/(\d+).*?stage \d+\/(\d+)/;
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    totals.set(match[1], { download: Number(match[2]), stage: Number(match[3]) });
  }

  return totals;
}

/**
 * Space actually occupied by a folder. Steam preallocates its staging folder to
 * the full download size, so apparent file sizes jump straight to 100%; the
 * allocated blocks are the bytes that have really arrived.
 */
function directoryBlocks(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directoryBlocks(full);
      else if (entry.isFile()) {
        const stat = statSync(full);
        total += (stat.blocks ?? 0) * 512 || stat.size;
      }
    } catch {
      // A file that vanished mid-walk is already gone.
    }
  }

  return total;
}

// Walking a staging folder is far more expensive than reading a counter, so it
// is measured a couple of seconds at a time.
const stagedSizes = new Map();

function stagedBytes(appid, library) {
  const now = Date.now();
  const cached = stagedSizes.get(appid);
  if (cached && now - cached.at < 2_500) return cached.bytes;

  const bytes = directoryBlocks(path.join(library, "downloading", appid));
  stagedSizes.set(appid, { bytes, at: now });
  return bytes;
}

/** Live progress for everything Steam is downloading right now. */
function downloadEntries() {
  const entries = {};

  for (const job of installJobs.values()) {
    entries[job.appid] = {
      appid: job.appid,
      state: job.state,
      detail: job.detail,
      done: 0,
      total: 0,
      speed: 0,
      eta: null,
    };
  }

  const bottles = steamBottles();
  if (!bottles.length) return entries;

  const log = steamBottleLog();
  const totals = downloadTotals(log);

  for (const entry of bottles.flatMap((bottle) => [...readManifests(bottle.dir).values()])) {
    const appid = entry.appid;
    const installed = (entry.state & 4) !== 0;
    const paused = pausedDownloads.has(appid);
    const staging = path.join(entry.library, "downloading", appid);

    const counters =
      entry.downloadTotal > 0 ||
      entry.download > 0 ||
      entry.stageTotal > 0 ||
      entry.staged > 0;

    // An installed app whose bytes are still moving is being updated, not
    // reinstalled; a finished one keeps its final counters and stays quiet.
    // "Paused" is a label on a real download, never a reason to invent one.
    const updating = updateInFlight(entry);
    const active = updating || (!installed && (counters || hasEntries(staging)));

    if (!active) {
      downloadSpeeds.delete(appid);
      downloadPeaks.delete(appid);
      stagedSizes.delete(appid);
      // Nothing is moving, so any pause flag left on this app is stale.
      pausedDownloads.delete(appid);
      // A finished install leaves no progress behind for its row. A job that has
      // not reached the download yet keeps its own entry alive.
      const busy = [...installJobs.values()].some(
        (job) => job.appid === appid && (job.state === "steam" || job.state === "waiting"),
      );
      if (installed && !busy) {
        pausedDownloads.delete(appid);
        delete entries[appid];
        for (const job of installJobs.values()) {
          if (job.appid === appid) installJobs.delete(job.id);
        }
      }
      continue;
    }

    const plan = totals.get(appid);
    const staged = stagedBytes(appid, entry.library);

    let done;
    let total;

    if (staged > 0) {
      // What is actually on disk against the size Steam said it needs.
      done = staged;
      total = plan?.stage ?? entry.stageTotal ?? 0;
    } else {
      done = entry.download + entry.staged;
      total = entry.downloadTotal + entry.stageTotal || plan?.stage || plan?.download || 0;
    }

    // Steam's staged bytes shrink back as files commit, so the bar holds its
    // high-water mark instead of walking backwards mid-download.
    const peak = downloadPeaks.get(appid);
    if (peak && done < peak) done = peak;
    downloadPeaks.set(appid, done);

    const speed = paused ? 0 : sampleSpeed(appid, done);
    const finishing = total > 0 && done >= total;

    entries[appid] = {
      appid,
      state: paused ? "paused" : updating ? "updating" : "downloading",
      detail: paused
        ? "Paused"
        : finishing
          ? updating
            ? "Wrapping up"
            : "Finishing up"
          : updating
            ? "Updating"
            : "Downloading",
      done,
      total,
      speed: paused || finishing ? 0 : speed,
      eta:
        !paused && !finishing && speed > 0 && total > done
          ? Math.round((total - done) / speed)
          : null,
    };
  }

  return entries;
}

export async function handleApi(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const host = (req.headers.host ?? "").split(":")[0];
  const local = LOOPBACK.has(host);

  if (url.pathname === "/api/games" && (req.method === "GET" || req.method === "HEAD")) {
    try {
      const result = detect();
      const names = loadNames();

      for (const game of result.games ?? []) {
        if (game.kind !== "steam") continue;
        const header = names[game.appid]?.assets?.header;
        // Never wait on Steam here. A cached URL is used as-is; otherwise the
        // image request itself resolves the art, so the rail is not held up by
        // a store lookup.
        game.icon = header ?? `/api/library-art?appid=${game.appid}&shape=header`;
        if (!header) ensureAssets(game.appid);
      }

      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/api/grid" && (req.method === "GET" || req.method === "HEAD")) {
    const file = resolveGridArt(url.searchParams.get("b") ?? "", url.searchParams.get("f") ?? "");
    if (!file) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("No such artwork");
      return;
    }
    res.setHeader("Content-Type", /\.png$/i.test(file) ? "image/png" : "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(readFileSync(file));
    return;
  }

  if (url.pathname === "/api/launch") {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    if (req.method === "GET") {
      const job = jobs.get(url.searchParams.get("id") ?? "");
      if (!job) {
        sendJson(res, 404, { ok: false, error: "Unknown launch" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        id: job.id,
        name: job.name,
        state: job.state,
        detail: job.detail,
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "POST or GET only" });
      return;
    }

    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const resolved = resolveGame(body);
    if (resolved.error) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }

    startLaunch(res, resolved.game);
    return;
  }

  if (url.pathname === "/api/status" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }
    sendJson(res, 200, runningState());
    return;
  }

  if (url.pathname === "/api/quit" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    const before = runningState();
    if (!before.any) {
      sendJson(res, 200, { ok: true, stopped: { steam: false, games: [] }, remaining: before });
      return;
    }

    // This stop was asked for, so the session ending now is not a crash.
    noteStop();
    for (const dir of listBottles()) await stopBottle(dir);
    await sleep(1_500);

    const after = runningState();
    sendJson(res, 200, {
      ok: true,
      stopped: { steam: before.steam, games: before.games },
      remaining: { steam: after.steam, games: after.games },
    });
    return;
  }

  if (url.pathname === "/api/library" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    try {
      const owned = steamBottles().flatMap((bottle) => [...readOwnedLibrary(bottle.dir).keys()]);
      const names = lookupNames(owned);
      sendJson(res, 200, { ok: true, ...librarySnapshot(names) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/api/downloads" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    try {
      sendJson(res, 200, { ok: true, downloads: downloadEntries() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/api/library-art" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    const appid = url.searchParams.get("appid") ?? "";
    if (!/^\d{1,10}$/.test(appid)) {
      sendJson(res, 400, { ok: false, error: "A numeric appid is required" });
      return;
    }

    const shape = url.searchParams.get("shape") === "header" ? "header" : "capsule";

    try {
      const art = await artworkFor(appid, shape);
      if (art) {
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "private, max-age=86400");
        res.end(readFileSync(art));
        return;
      }
    } catch {
      // Fall through to whatever the local Steam cache has.
    }

    const bottle = bottleForApp(appid).bottle;
    const entry = bottle ? readOwnedLibrary(bottle.dir).get(appid) : null;

    if (!entry?.art) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("No art for that app");
      return;
    }

    res.setHeader("Content-Type", /\.png$/i.test(entry.art) ? "image/png" : "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(readFileSync(entry.art));
    return;
  }

  if (url.pathname === "/api/clip" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    const appid = url.searchParams.get("appid") ?? "";
    if (!/^\d{1,10}$/.test(appid)) {
      sendJson(res, 400, { ok: false, error: "A numeric appid is required" });
      return;
    }

    try {
      const clip = await clipFor(appid);
      sendJson(res, 200, { ok: Boolean(clip.url), ...clip });
    } catch (error) {
      sendJson(res, 500, { ok: false, appid, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/api/clip-file" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    const appid = url.searchParams.get("appid") ?? "";
    const file = /^\d{1,10}$/.test(appid) ? clipPath(appid) : "";

    if (!file || !existsSync(file)) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("No clip cached for that app");
      return;
    }

    // Video elements ask for byte ranges; without 206 support the clip cannot
    // seek, and looping a twelve second file means seeking constantly.
    const size = statSync(file).size;
    let start = 0;
    let end = size - 1;

    const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range ?? "").trim());
    if (range) {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;

      if (!Number.isFinite(start) || start >= size || end < start) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }

      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Length", String(end - start + 1));

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(file, { start, end }).pipe(res);
    return;
  }

  if (url.pathname === "/api/install" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be JSON" });
      return;
    }

    const appid = String(payload?.appid ?? "");
    if (!/^\d{1,10}$/.test(appid)) {
      sendJson(res, 400, { ok: false, error: "A numeric appid is required" });
      return;
    }

    const { bottle, state } = bottleForApp(appid);
    if (!bottle) {
      sendJson(res, 500, { ok: false, error: "No Steam install found in a bottle" });
      return;
    }

    // Install only what this account actually owns, and only what is missing.
    if (!readOwnedLibrary(bottle.dir).has(appid)) {
      sendJson(res, 404, { ok: false, error: "That app isn't in this account's library" });
      return;
    }

    if (state && (state.state & 4) !== 0) {
      sendJson(res, 409, { ok: false, error: "That game is already installed" });
      return;
    }

    const meta = await installTarget(appid);
    if (!meta?.installdir) {
      sendJson(res, 422, { ok: false, error: "Steam doesn't say where this app installs" });
      return;
    }

    // A download that cannot fit fails halfway through and leaves staging
    // behind, so the space is settled before Steam is touched at all.
    const free = freeSpace(bottle.dir);
    if (spaceShortfall(meta.size, free) > 0) {
      sendJson(res, 507, {
        ok: false,
        error: `Needs about ${gb(meta.size)} and only ${gb(free)} is free`,
        size: meta.size,
        free,
      });
      return;
    }

    // No steam:// URL: that opens the client's Install dialog and waits for a
    // click. A pending manifest is downloaded by the silenced client instead.
    const command = `wine64 start /unix '${bottle.exe}' -silent`;

    if (process.env.WHISKY_GAMES_DRY === "1") {
      sendJson(res, 200, { ok: true, dryRun: true, appid, command, via: "pending manifest" });
      return;
    }

    if (!wineRuntime().ok && !existsSync(WHISKY_CLI)) {
      sendJson(res, 501, { ok: false, error: "No Wine runtime found — run node scripts/fetch-runtime.mjs" });
      return;
    }

    installCounter += 1;
    const job = {
      id: `i${Date.now().toString(36)}${installCounter}`,
      appid,
      state: "steam",
      detail: "Getting Steam ready",
      startedAt: Date.now(),
    };
    installJobs.set(job.id, job);

    runInstall(job, appid, bottle, meta);

    sendJson(res, 200, { ok: true, appid, job: job.id, command });
    return;
  }

  if (url.pathname === "/api/uninstall" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be JSON" });
      return;
    }

    const appid = String(payload?.appid ?? "");
    if (!/^\d{1,10}$/.test(appid)) {
      sendJson(res, 400, { ok: false, error: "A numeric appid is required" });
      return;
    }

    const { bottle, state } = bottleForApp(appid);
    if (!bottle) {
      sendJson(res, 500, { ok: false, error: "No Steam install found in a bottle" });
      return;
    }

    // A half-finished download can be removed too: that is how a download is
    // cancelled without Steam's own window.
    if (!state) {
      sendJson(res, 404, { ok: false, error: "That app isn't installed" });
      return;
    }

    // Everything is resolved from the manifest on disk, never from the request.
    const common = path.resolve(state.library, "common");
    const target = state.installdir ? path.resolve(common, state.installdir) : "";
    if (!target || target === common || !target.startsWith(`${common}${path.sep}`)) {
      sendJson(res, 400, { ok: false, error: "That app's install folder looks unsafe to remove" });
      return;
    }

    if (process.env.WHISKY_GAMES_DRY === "1") {
      sendJson(res, 200, { ok: true, dryRun: true, appid, name: state.name, path: target });
      return;
    }

    // Steam holds these files open and rewrites the manifest on exit, so the
    // client goes first. It has no window, so this is invisible either way.
    for (const dir of listBottles()) await stopBottle(dir);
    await sleep(1_500);

    let freed = 0;
    try {
      freed = directorySize(target) || state.sizeOnDisk;
      rmSync(target, { recursive: true, force: true });
      rmSync(state.file, { force: true });
      rmSync(path.join(state.library, "downloading", appid), { recursive: true, force: true });
      rmSync(path.join(state.library, "shadercache", appid), { recursive: true, force: true });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: `Couldn't remove it cleanly — ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    downloadSpeeds.delete(appid);
    for (const job of installJobs.values()) {
      if (job.appid === appid) installJobs.delete(job.id);
    }

    sendJson(res, 200, { ok: true, appid, name: state.name, freed });
    return;
  }

  if (url.pathname === "/api/download" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be JSON" });
      return;
    }

    const appid = String(payload?.appid ?? "");
    const action = String(payload?.action ?? "");
    if (!/^\d{1,10}$/.test(appid)) {
      sendJson(res, 400, { ok: false, error: "A numeric appid is required" });
      return;
    }
    if (!["pause", "resume", "cancel"].includes(action)) {
      sendJson(res, 400, { ok: false, error: "action must be pause, resume or cancel" });
      return;
    }

    const { bottle, state } = bottleForApp(appid);
    if (!bottle) {
      sendJson(res, 500, { ok: false, error: "No Steam install found in a bottle" });
      return;
    }

    if (!state) {
      sendJson(res, 404, { ok: false, error: "That app isn't downloading" });
      return;
    }

    const installed = (state.state & 4) !== 0;
    if (action === "cancel" && installed) {
      sendJson(res, 409, { ok: false, error: "It's installed — uninstall it from its row instead" });
      return;
    }

    if (process.env.WHISKY_GAMES_DRY === "1") {
      sendJson(res, 200, { ok: true, dryRun: true, appid, action, installed });
      return;
    }

    if (action === "cancel") {
      const result = await cancelDownload(appid, state);
      sendJson(res, result.status, result.body);
      return;
    }

    if (runningState().games.length > 0) {
      sendJson(res, 409, {
        ok: false,
        error: "Close the running game first — Steam can't pause or resume while it plays",
      });
      return;
    }

    if (action === "pause") {
      if (!activeDownload(state)) {
        sendJson(res, 409, { ok: false, error: "Nothing is downloading for that app" });
        return;
      }

      for (const dir of listBottles()) await stopBottle(dir);
      pausedDownloads.set(appid, Date.now());
      downloadSpeeds.delete(appid);
      sendJson(res, 200, { ok: true, appid, state: "paused" });
      return;
    }

    if (installed && !activeDownload(state)) {
      sendJson(res, 409, { ok: false, error: "There's no update in progress for that app" });
      return;
    }

    pausedDownloads.delete(appid);
    const job = startResume(appid, bottle);
    sendJson(res, 200, { ok: true, appid, job: job.id, state: "waiting" });
    return;
  }

  if (url.pathname === "/api/update" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be JSON" });
      return;
    }

    const appid = String(payload?.appid ?? "");
    if (!/^\d{1,10}$/.test(appid)) {
      sendJson(res, 400, { ok: false, error: "A numeric appid is required" });
      return;
    }

    const { bottle, state } = bottleForApp(appid);
    if (!bottle) {
      sendJson(res, 500, { ok: false, error: "No Steam install found in a bottle" });
      return;
    }

    if (!state || (state.state & 4) === 0) {
      sendJson(res, 404, { ok: false, error: "That game isn't installed" });
      return;
    }

    if (runningState().games.length > 0) {
      sendJson(res, 409, { ok: false, error: "Close the running game first" });
      return;
    }

    const command = `wine64 start /unix '${bottle.exe}' -silent`;

    if (process.env.WHISKY_GAMES_DRY === "1") {
      sendJson(res, 200, {
        ok: true,
        dryRun: true,
        appid,
        command,
        via: "update required flag",
      });
      return;
    }

    if (!wineRuntime().ok && !existsSync(WHISKY_CLI)) {
      sendJson(res, 501, { ok: false, error: "No Wine runtime found — run node scripts/fetch-runtime.mjs" });
      return;
    }

    const job = startUpdate(appid, bottle);
    sendJson(res, 200, { ok: true, appid, job: job.id, command });
    return;
  }

  if (url.pathname === "/api/verify" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be JSON" });
      return;
    }

    const appid = String(payload?.appid ?? "");
    if (!/^\d{1,10}$/.test(appid)) {
      sendJson(res, 400, { ok: false, error: "A numeric appid is required" });
      return;
    }

    const { bottle, state } = bottleForApp(appid);
    if (!bottle) {
      sendJson(res, 500, { ok: false, error: "No Steam install found in a bottle" });
      return;
    }
    if (!state || (state.state & 4) === 0) {
      sendJson(res, 404, { ok: false, error: "That game isn't installed" });
      return;
    }

    if (runningState().games.length > 0) {
      sendJson(res, 409, { ok: false, error: "Close the running game first" });
      return;
    }

    if (process.env.WHISKY_GAMES_DRY === "1") {
      sendJson(res, 200, { ok: true, dryRun: true, appid, via: "update required flag" });
      return;
    }

    if (!wineRuntime().ok && !existsSync(WHISKY_CLI)) {
      sendJson(res, 501, { ok: false, error: "No Wine runtime found — run node scripts/fetch-runtime.mjs" });
      return;
    }

    const job = startUpdate(appid, bottle, "verify");
    sendJson(res, 200, { ok: true, appid, job: job.id, via: "verify" });
    return;
  }

  if (url.pathname === "/api/job" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    const id = url.searchParams.get("id") ?? "";
    const job = jobs.get(id) ?? installJobs.get(id);
    if (!job) {
      sendJson(res, 404, { ok: false, error: "Unknown job" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      id: job.id,
      appid: job.appid ?? null,
      name: job.name ?? null,
      mode: job.mode ?? null,
      state: job.state,
      detail: job.detail,
      result: job.result ?? null,
    });
    return;
  }

  if (url.pathname === "/api/preflight" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    try {
      sendJson(res, 200, { ok: true, ...preflight() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // Where the bottles live, and how many still sit in Whisky's folder.
  if (url.pathname === "/api/bottles" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    try {
      sendJson(res, 200, { ok: true, ...migrationPlan() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // Moves games off Whisky for good: a rename, then a check that every game is
  // still readable from the new place. POST because the folder moves.
  if (url.pathname === "/api/bottles/migrate" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let plan;
    try {
      plan = migrationPlan();
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (!plan.bottles.length) {
      sendJson(res, 200, { ok: true, moved: 0, results: [], remaining: 0, nothing: true });
      return;
    }

    jobCounter += 1;
    const job = {
      id: `m${Date.now().toString(36)}${jobCounter}`,
      name: "Moving bottles off Whisky",
      state: "queued",
      detail: "Getting ready",
      startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    runMigration(job);

    sendJson(res, 200, { ok: true, id: job.id, job: job.id, bottles: plan.bottles.length });
    return;
  }

  // The DLL payloads and VC++ runtimes a bottle built here needs.
  if (url.pathname === "/api/payloads" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    try {
      sendJson(res, 200, { ok: true, ...payloadStatus() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // Re-run the DXVK/VC++ steps on a bottle this app already owns.
  if (url.pathname === "/api/bottle/prepare" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be JSON" });
      return;
    }

    const dir = bottleDirNamed(String(payload?.name ?? ""));
    const own = path.resolve(OWN_BOTTLES);
    if (!dir || !path.resolve(dir).startsWith(`${own}${path.sep}`)) {
      sendJson(res, 404, { ok: false, error: "That is not a bottle this app built" });
      return;
    }

    try {
      const prepared = await prepareBottle(dir);
      sendJson(res, 200, { ok: prepared.ok, name: path.basename(dir), ...prepared });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // Why a game closed: the reports written when a session ends unasked.
  if (url.pathname === "/api/crashes" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
    sendJson(res, 200, {
      ok: true,
      crashes: listCrashes(limit).map((report) => ({
        id: report.id,
        appid: report.appid,
        name: report.name,
        bottle: report.bottle,
        endedAt: report.endedAt,
        seconds: report.seconds,
        unexpected: report.unexpected,
        firstRun: report.firstRun === true,
        signals: report.signals?.length ?? 0,
      })),
    });
    return;
  }

  if (url.pathname === "/api/crash" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    const report = readCrash(url.searchParams.get("id") ?? "");
    if (!report) {
      sendJson(res, 404, { ok: false, error: "No such report" });
      return;
    }

    sendJson(res, 200, { ok: true, report });
    return;
  }

  // First-run setup: the Wine tree itself, downloaded by the app.
  if (url.pathname === "/api/runtime/install" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    sendJson(res, 200, { ok: true, ...runtimeInstallStatus() });
    return;
  }

  if (url.pathname === "/api/runtime/install" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    // A runtime already on this Mac — this app's or Whisky's — is used as-is.
    if (wineRuntime().ok) {
      sendJson(res, 200, { ok: true, ...runtimeInstallStatus(), already: true, running: false });
      return;
    }

    installRuntime().catch(() => {});
    sendJson(res, 202, { ok: true, ...runtimeInstallStatus() });
    return;
  }

  // Which Wine this app is running, and proof that it can launch through it.
  if (url.pathname === "/api/runtime" && (req.method === "GET" || req.method === "HEAD")) {
    if (!local) {
      sendJson(res, 403, { ok: false, error: "Local requests only" });
      return;
    }

    try {
      sendJson(res, 200, { ok: true, ...runtimeInfo() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // Runs a program through the runtime, so "found Wine" and "Wine works" are
  // not the same claim. POST because it launches a process.
  if (url.pathname === "/api/runtime/check" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    try {
      // The bottle in use is the one worth proving: that is where games run.
      const result = await runtimeSelfTest(steamBottles()[0]?.dir);

      // A runtime that can launch programs is not the whole story: a bottle
      // missing dxgi or d3d9 renders nothing, so the payload earns its own row.
      const checks = [...result.checks, ...payloadSelfTest()];
      sendJson(res, 200, {
        ok: true,
        checks,
        healthy: checks.every((check) => check.ok),
        prefix: result.prefix,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // First run without Steam: build the bottle and install it from here.
  if (url.pathname === "/api/setup/steam" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    const existing = steamInstallBottles();
    if (existing.length) {
      sendJson(res, 200, {
        ok: true,
        already: true,
        bottles: existing.map((bottle) => bottle.name),
      });
      return;
    }

    if (steamSetupJob) {
      sendJson(res, 200, {
        ok: true,
        id: steamSetupJob.id,
        job: steamSetupJob.id,
        state: steamSetupJob.state,
        detail: steamSetupJob.detail,
      });
      return;
    }

    jobCounter += 1;
    const job = {
      id: `s${Date.now().toString(36)}${jobCounter}`,
      name: "Setting up Steam",
      state: "queued",
      detail: "Getting ready",
      startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    steamSetupJob = job;
    runSteamSetup(job);

    sendJson(res, 202, {
      ok: true,
      id: job.id,
      job: job.id,
      state: job.state,
      detail: job.detail,
    });
    return;
  }

  // Steam is installed but its window is closed: bring it back for sign-in.
  if (url.pathname === "/api/steam/open" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    const installed = steamInstallBottles()[0];
    if (!installed) {
      sendJson(res, 404, { ok: false, error: "Steam is not installed in a bottle yet" });
      return;
    }

    const pid = wineLaunch(installed.dir, installed.exe);
    if (!pid) {
      sendJson(res, 500, { ok: false, error: "Wine could not open Steam" });
      return;
    }

    sendJson(res, 200, { ok: true, bottle: installed.name, pid });
    return;
  }

  // A bottle this app owns, built with its own runtime: no Whisky involved.
  if (url.pathname === "/api/bottle" && req.method === "POST") {
    if (!local || !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "Local, same-origin requests only" });
      return;
    }

    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be JSON" });
      return;
    }

    const name = String(payload?.name ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) {
      sendJson(res, 400, { ok: false, error: "Use letters, numbers, spaces, dots, dashes or underscores" });
      return;
    }

    if (process.env.WHISKY_GAMES_DRY === "1") {
      sendJson(res, 200, { ok: true, dryRun: true, name, dir: path.join(OWN_BOTTLES, name) });
      return;
    }

    const made = await makeBottle(path.join(OWN_BOTTLES, name));
    if (!made.ok) {
      sendJson(res, 500, { ok: false, name, ...made });
      return;
    }

    // A bare prefix is only half a bottle: give it the DLL payloads and the
    // runtimes a game expects, so a game installed here behaves like one
    // installed in a bottle Whisky built.
    const prepared = await prepareBottle(made.dir);
    sendJson(res, 200, { ok: true, name, ...made, prepared });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Unknown endpoint" });
}
