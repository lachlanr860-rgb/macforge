import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, closeSync, chmodSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, run, runtime, wineEnv } from "./runtime.mjs";

/**
 * Steam's own sign-in window under Wine on Apple Silicon.
 *
 * Steam's CEF layer (Chromium 126) paints the login window black here. Its
 * renderer and GPU processes each ask for a D3D11 swapchain on a window owned
 * by another process, and Wine's mac driver cannot hand a Metal layer across
 * that boundary, so the compositor never receives a frame — DXMT returns
 * E_FAIL for the cross-process case, and the GPU process itself dies with
 * 0xC0000005 (`GPU process exited unexpectedly: exit_code=-1073741819`).
 *
 * The window is drawn by:
 *
 *   1. A `steamwebhelper.exe` shim that starts the real helper with
 *      `--disable-gpu --single-process`. CPU rasterisation sidesteps the
 *      cross-process swapchain, and collapsing the renderer, GPU and network
 *      service into one process also keeps the login request off Wine's
 *      winsock TLS path (net_error -100/-107).
 *   2. Per-program `DllOverrides` giving the helper Wine's builtin
 *      dxgi/d3d11/d3d10core/d3d9. The prefix is DXVK-native, and in
 *      single-process mode CEF loads DXGI in the browser process, where DXVK's
 *      dxgi.dll faults on Wine 11 — the shim alone crashes there.
 *
 * The shim only has to exist until Steam is signed in: it exists to draw the
 * login window, and a signed-in client never shows one. That matters, because
 * a modified helper is fragile in two ways, both measured here:
 *
 *   · Steam's client restores its own helper within seconds of finding it
 *     changed, and its bootstrapper re-downloads the client when the size does
 *     not match. `steam.cfg` with `BootStrapperInhibitAll=enable` stops that,
 *     but it also stops the restart Steam performs *after a successful logon*,
 *     so the client closed and never came back — signing in appeared to kill
 *     the app, and nothing was saved, so the next launch asked to sign in again.
 *   · Leaving the shim read-only, or pasting it in mid-session, makes the client
 *     retry the helper endlessly (hundreds of steamwebhelper_real.exe).
 *
 * So the shim (and the inhibit) is installed only while Steam is signed out,
 * and is removed as soon as the log proves a logon succeeded — before Steam
 * restarts itself. From then on the client is stock, updates and restarts
 * behave, and the app drives the library without needing any window.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, "steam", "steamwebhelper.exe");

const STEAM_DIRS = ["drive_c/Program Files (x86)/Steam", "drive_c/Program Files/Steam"];

// Steam's real helper is about 7 MB; the shim is about 0.2 MB.
const SHIM_SIZE_MAX = 1_000_000;

const OVERRIDE_DLLS = ["dxgi", "d3d11", "d3d10core", "d3d9"];
const OVERRIDE_EXES = ["steamwebhelper.exe", "steamwebhelper_real.exe"];

const MARKER = "drive_c/MacForge/steam-fix.json";

// Written when the shim has been seen looping; from then on the client is left
// stock, whatever the sign-in state.
const FIX_OFF = "drive_c/MacForge/steam-shim-disabled";

const INHIBIT = "BootStrapperInhibitAll=enable";

const LOGON_RE = /Received logon success response/i;

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The Steam install inside a bottle, or null. */
function steamDir(prefix) {
  for (const rel of STEAM_DIRS) {
    const dir = path.join(prefix, rel);
    if (existsSync(path.join(dir, "steam.exe"))) return dir;
  }
  return null;
}

/**
 * Has this client signed in? Steam records the accounts it knows in
 * config/loginusers.vdf, one block per account, once a logon has completed.
 */
function signedIn(steam) {
  const users = readText(path.join(steam, "config", "loginusers.vdf"));
  if (!users) return false;
  // A block looks like: "7656119…" { "AccountName" "name" "PersonaName" … }
  return /"AccountName"\s+"[^"]+"|"PersonaName"\s+"[^"]+"/i.test(users);
}

/** Does this file start with the shim's bytes and have the expected size? */
function isShim(file, target) {
  if (sizeOf(file) !== target) return false;

  const shim = readFileSync(SHIM);
  let head;
  try {
    const fd = openSync(file, "r");
    head = Buffer.alloc(shim.length);
    readSync(fd, head, 0, shim.length, 0);
    closeSync(fd);
  } catch {
    return false;
  }
  return head.equals(shim);
}

/**
 * Put the shim in place, padded to the size of the real helper so Steam's size
 * check is satisfied even after the inhibit is lifted.
 */
function installShim(cef) {
  const helper = path.join(cef, "steamwebhelper.exe");
  const real = path.join(cef, "steamwebhelper_real.exe");

  if (!existsSync(SHIM)) return { ok: false, detail: "the shim is missing from the app bundle" };

  if (sizeOf(helper) > SHIM_SIZE_MAX) {
    try {
      chmodSync(helper, 0o644);
      rmSync(real, { force: true });
      renameSync(helper, real);
    } catch (error) {
      return { ok: false, detail: `could not move the helper aside: ${error.message}` };
    }
  }

  const target = sizeOf(real);
  if (!target) return { ok: false, detail: "the real steamwebhelper is missing" };
  if (isShim(helper, target)) return { ok: true, changed: false, detail: "shim already in place" };

  try {
    if (existsSync(helper)) chmodSync(helper, 0o644);
    copyFileSync(SHIM, helper);
    const pad = target - sizeOf(SHIM);
    if (pad > 0) writeFileSync(helper, Buffer.alloc(pad), { flag: "a" });
    chmodSync(helper, 0o644);
  } catch (error) {
    return { ok: false, detail: `could not write the shim: ${error.message}` };
  }

  return { ok: true, changed: true, detail: "shim installed" };
}

/** Put Steam's own helper back, for a client that is signed in. */
function restoreStock(cef) {
  const helper = path.join(cef, "steamwebhelper.exe");
  const real = path.join(cef, "steamwebhelper_real.exe");

  if (!existsSync(real)) return false;
  if (sizeOf(helper) === sizeOf(real) && isShim(helper, sizeOf(real)) === false) {
    // Same size and not the shim: already stock.
    return false;
  }

  try {
    if (existsSync(helper)) chmodSync(helper, 0o644);
    copyFileSync(real, helper);
    chmodSync(helper, 0o644);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep or drop the bootstrapper inhibit. While signed out it is what stops
 * Steam restoring the helper; once signed in it must go, because it also stops
 * the post-logon restart.
 */
function setInhibit(steam, on) {
  const file = path.join(steam, "steam.cfg");
  const current = readText(file);

  const kept = current
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*BootStrapperInhibitAll\s*=/i.test(line));

  const lines = on ? [...kept, INHIBIT] : kept;
  const next = lines.length ? lines.join("\n") + "\n" : "";

  if (next === current) return false;
  try {
    if (!next) rmSync(file, { force: true });
    else writeFileSync(file, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wine's builtin DXGI for the helper only. Prefix-wide DXVK stays native-first,
 * so games are untouched; these two program entries are read first for the
 * helper's processes.
 *
 * One registry import rather than a `reg add` per value: each launch of a
 * Windows program costs seconds under Wine, and a fresh bottle needs eight.
 */
async function installOverrides(prefix) {
  const file = path.join(prefix, "drive_c/MacForge/steam-fix.reg");
  const lines = ["Windows Registry Editor Version 5.00", ""];

  for (const exe of OVERRIDE_EXES) {
    lines.push(`[HKEY_CURRENT_USER\\Software\\Wine\\AppDefaults\\${exe}\\DllOverrides]`);
    for (const dll of OVERRIDE_DLLS) lines.push(`"${dll}"="builtin"`);
    lines.push("");
  }

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\r\n"));
  } catch (error) {
    return { ok: false, done: 0, failed: [error.message] };
  }

  const result = await run(prefix, "C:\\windows\\system32\\reg.exe", ["import", "C:\\MacForge\\steam-fix.reg"], 120_000);

  const count = OVERRIDE_EXES.length * OVERRIDE_DLLS.length;
  return result.ok
    ? { ok: true, done: count, failed: [] }
    : { ok: false, done: 0, failed: [(result.stderr || result.stdout || "reg import failed").trim().slice(0, 200)] };
}

/** Has this prefix already been given the overrides, for this shim? */
function markerMatches(prefix) {
  try {
    const mark = JSON.parse(readFileSync(path.join(prefix, MARKER), "utf8"));
    return mark?.shim === sizeOf(SHIM) && Array.isArray(mark.dlls) && mark.dlls.length === OVERRIDE_DLLS.length;
  } catch {
    return false;
  }
}

function writeMarker(prefix) {
  try {
    const file = path.join(prefix, MARKER);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ shim: sizeOf(SHIM), dlls: OVERRIDE_DLLS, at: new Date().toISOString() }));
  } catch {
    // Bookkeeping only.
  }
}

/**
 * Make Steam's sign-in window draw in this bottle, or step out of the way of a
 * client that no longer needs it. Safe to call before every launch.
 */
export async function applySteamFix(prefix) {
  const steam = steamDir(prefix);
  if (!steam) return { ok: false, detail: "no Steam install in this bottle" };

  const cef = path.join(steam, "bin", "cef", "cef.win64");
  if (!existsSync(cef)) return { ok: false, detail: "Steam's CEF folder is not there yet" };

  // A bottle where the shim looped stays stock: a stock client that draws
  // nothing is better than one that spawns helpers without end.
  if (existsSync(path.join(prefix, FIX_OFF))) {
    restoreStock(cef);
    setInhibit(steam, false);
    return { ok: true, changed: false, shim: false, cfgCleared: false, overrides: 0, detail: "stock client (shim disabled for this bottle)" };
  }

  // Signed in: the login window is gone for good, so leave the client stock.
  if (signedIn(steam)) {
    const restored = restoreStock(cef);
    const cfgCleared = setInhibit(steam, false);
    return {
      ok: true,
      changed: restored || cfgCleared,
      shim: false,
      cfgCleared,
      overrides: 0,
      detail: restored || cfgCleared ? "signed in; stock helper restored" : "signed in; stock client",
    };
  }

  const shim = installShim(cef);
  const cfg = setInhibit(steam, true);

  let overrides = { ok: true, done: 0, failed: [], cached: true };
  if (!markerMatches(prefix)) {
    overrides = { ...(await installOverrides(prefix)), cached: false };
    if (overrides.ok) writeMarker(prefix);
  }

  const parts = [shim.detail];
  if (cfg) parts.push("bootstrapper held");
  if (!overrides.cached) parts.push(overrides.ok ? `${overrides.done} overrides` : `overrides failed: ${overrides.failed[0]}`);

  return {
    ok: shim.ok && overrides.ok,
    changed: Boolean(shim.changed || cfg || (overrides.done ?? 0) > 0),
    shim: shim.ok,
    cfg,
    overrides: overrides.done ?? 0,
    detail: parts.join(" · "),
  };
}

/**
 * Steam's CEF builds its interface cache in htmlcache while the client runs.
 * A warm cache is 50–80 MB; a bottle whose cache is missing or only a few MB
 * old is cold, and the shim's single-process client cannot build one — it
 * respawns the helper instead (the hundreds-of-helpers storm). A stock launch
 * builds the cache normally, so it is started first and closed again once the
 * cache is warm enough to hand to the shim.
 */
const NEARLY_EMPTY = 12 * 1024 * 1024;
const WARM_WAIT_MS = 180_000;

/**
 * The htmlcache the client actually reads, whether or not it exists yet.
 *
 * A bottle can hold more than one Windows profile — `crossover` and the macOS
 * user name both occur — and each may carry an old htmlcache. The live one is
 * the profile Steam writes `local.vdf` into, so that is chosen; falling back to
 * the newest one keeps a bottle with no `local.vdf` from looking warm on the
 * strength of a stale profile's cache.
 */
function cacheDir(prefix) {
  const users = path.join(prefix, "drive_c", "users");
  let names;
  try {
    names = readdirSync(users);
  } catch {
    return null;
  }

  const candidates = [];
  for (const name of names) {
    const local = path.join(users, name, "AppData", "Local", "Steam");
    if (!existsSync(local)) continue;
    let mtime = 0;
    try {
      mtime = statSync(local).mtimeMs;
    } catch {
      // Unreadable is as good as absent.
    }
    candidates.push({ dir: path.join(local, "htmlcache"), active: existsSync(path.join(local, "local.vdf")), mtime });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.active) - Number(a.active) || b.mtime - a.mtime);
  return candidates[0].dir;
}

function bytesIn(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
        continue;
      }
      try {
        total += statSync(file).size;
      } catch {
        // A file the client is rewriting; it is counted on a later pass.
      }
    }
  }
  return total;
}

function steamClientRunning() {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "args="], { maxBuffer: 8_000_000 }, (error, stdout) => {
      if (error) return resolve(true);
      resolve(/[\\/]Steam[\\/]steam\.exe/i.test(stdout));
    });
  });
}

/** Close this bottle and wait for its client to be gone. */
async function stopPrefix(prefix) {
  const rt = runtime();
  if (rt.wineserver) {
    try {
      spawn(rt.wineserver, ["-k"], { env: wineEnv(prefix), stdio: "ignore" }).unref();
    } catch {
      // Whatever is left is caught by the launch guard.
    }
  }
  for (let i = 0; i < 40; i += 1) {
    if (!(await steamClientRunning())) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Give a cold bottle a warm interface cache before the shim is installed.
 * Safe to call before every launch: a warm cache, a signed-in client and a
 * bottle where the shim is disabled all return straight away.
 */
export async function warmSteamCache(prefix, { minBytes = NEARLY_EMPTY, timeoutMs = WARM_WAIT_MS, pollMs = 3_000 } = {}) {
  const steam = steamDir(prefix);
  if (!steam) return { ok: false, warmed: false, bytes: 0, detail: "no Steam install in this bottle" };

  const cache = cacheDir(prefix);
  const before = cache ? bytesIn(cache) : 0;

  // A stock client builds its cache without help, and the shim that needs a
  // warm one is never installed for a signed-in or shim-disabled bottle.
  if (signedIn(steam) || existsSync(path.join(prefix, FIX_OFF))) {
    return { ok: true, warmed: false, bytes: before, detail: "stock client; no warm-up needed" };
  }

  if (before >= minBytes) return { ok: true, warmed: false, bytes: before, detail: "interface cache already warm" };

  const rt = runtime();
  if (!rt.ok) return { ok: false, warmed: false, bytes: before, detail: "no Wine runtime to warm the cache with" };
  if (await steamClientRunning()) {
    return { ok: true, warmed: false, bytes: before, detail: "Steam is already open; it is building its own cache" };
  }

  const cef = path.join(steam, "bin", "cef", "cef.win64");
  restoreStock(cef);
  setInhibit(steam, false);

  const windowsExe = `C:${path.relative(path.join(prefix, "drive_c"), steam).split(path.sep).join("\\")}\\steam.exe`;
  if (!launch(prefix, windowsExe)) {
    return { ok: false, warmed: false, bytes: before, detail: "Wine could not open Steam to warm the cache" };
  }

  const startedAt = Date.now();
  let bytes = before;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    bytes = cache ? bytesIn(cache) : 0;
    if (bytes < minBytes) continue;

    // Warm enough: close the stock client so the shim starts on a quiet prefix.
    await stopPrefix(prefix);
    return { ok: true, warmed: true, bytes, detail: `rebuilt Steam's interface cache (${Math.round(bytes / 1_048_576)} MB)` };
  }

  // Cold after waiting: still give it up, and let the guard stop a loop if one
  // starts. Leaving a stock client running would fight the launch below.
  await stopPrefix(prefix);
  return { ok: false, warmed: false, bytes, detail: "Steam's interface cache stayed small" };
}

/**
 * How many webhelper processes this bottle has. One browser process is enough
 * for the shim; a rising count means Steam is respawning a helper that cannot
 * start.
 */
function countHelpers() {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "args="], { maxBuffer: 8_000_000 }, (error, stdout) => {
      if (error) return resolve(0);
      resolve(stdout.split("\n").filter((line) => line.includes("steamwebhelper")).length);
    });
  });
}

/**
 * Stop a helper loop before it fills the machine: kill the bottle, put Steam's
 * own helper back and disable the shim for this bottle for good. Resolves with
 * what it saw, or null if the launch looked healthy.
 */
export function guardSteamLaunch(prefix, { limit = 12, intervalMs = 5_000, watchMs = 120_000 } = {}) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      const count = await countHelpers();

      if (count > limit) {
        clearInterval(timer);

        const rt = runtime();
        if (rt.wineserver) {
          try {
            spawn(rt.wineserver, ["-k"], { env: wineEnv(prefix), stdio: "ignore" }).unref();
          } catch {
            // Nothing else to do; the files are put back below either way.
          }
        }

        const steam = steamDir(prefix);
        if (steam) {
          restoreStock(path.join(steam, "bin", "cef", "cef.win64"));
          setInhibit(steam, false);
        }

        try {
          const file = path.join(prefix, FIX_OFF);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, `${new Date().toISOString()} webhelper processes: ${count}\n`);
        } catch {
          // Bookkeeping only.
        }

        resolve({ loop: true, count });
        return;
      }

      if (Date.now() - startedAt > watchMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, intervalMs);
  });
}

/**
 * Watch the client's login log and step out of its way the moment a logon
 * succeeds: Steam restarts itself a few seconds later, and the restart needs
 * its own helper and a working bootstrapper. Resolves with what it did, or
 * null if nothing happened before the timeout.
 */
export function watchSteamLogin(prefix, { timeoutMs = 15 * 60_000, intervalMs = 1_500 } = {}) {
  const steam = steamDir(prefix);
  if (!steam) return Promise.resolve(null);

  const file = path.join(steam, "logs", "steamui_login.txt");
  const cef = path.join(steam, "bin", "cef", "cef.win64");
  let offset = sizeOf(file);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      // Only read what was appended since the last look.
      const size = sizeOf(file);
      if (size < offset) offset = 0;

      if (size > offset) {
        let chunk = "";
        try {
          const fd = openSync(file, "r");
          const buffer = Buffer.alloc(size - offset);
          readSync(fd, buffer, 0, buffer.length, offset);
          closeSync(fd);
          chunk = buffer.toString("utf8");
        } catch {
          chunk = "";
        }
        offset = size;

        if (LOGON_RE.test(chunk)) {
          clearInterval(timer);
          setInhibit(steam, false);
          const restored = restoreStock(cef);
          resolve({ loggedIn: true, restored });
          return;
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, intervalMs);
  });
}
