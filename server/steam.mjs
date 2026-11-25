import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./runtime.mjs";

/**
 * Steam's own sign-in window under Wine on Apple Silicon.
 *
 * Steam's CEF layer (Chromium 126) paints the login window black here. Its
 * renderer and GPU processes each ask for a D3D11 swapchain on a window owned
 * by another process, and wine's mac driver cannot hand a Metal layer across
 * that boundary, so the compositor never receives a frame — DXMT returns
 * E_FAIL for the cross-process case, and the GPU process itself dies with
 * 0xC0000005 (`GPU process exited unexpectedly: exit_code=-1073741819`). Three
 * changes together make the window draw:
 *
 *   1. A `steamwebhelper.exe` shim that starts the real helper with
 *      `--disable-gpu --single-process`. CPU rasterisation sidesteps the
 *      cross-process swapchain entirely, and collapsing the renderer, GPU and
 *      network service into one process also keeps the login request off
 *      Wine's winsock TLS path (net_error -100/-107).
 *   2. `steam.cfg` with `BootStrapperInhibitAll=enable`, because Steam's
 *      bootstrapper silently restores its own helper on the next start.
 *   3. Per-program `DllOverrides` giving the helper Wine's builtin
 *      dxgi/d3d11/d3d10core/d3d9. The prefix is DXVK-native, and in
 *      single-process mode CEF loads DXGI in the browser process, where DXVK's
 *      dxgi.dll faults on Wine 11 — the shim alone crashes there.
 *
 * Measured on this Mac: with only (1)+(2) the helper dies in DXVK's dxgi; with
 * all three the 700x440 login window renders fully, including its QR code.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, "steam", "steamwebhelper.exe");

const STEAM_DIRS = ["drive_c/Program Files (x86)/Steam", "drive_c/Program Files/Steam"];

// Steam's real helper is about 7 MB; the shim is about 0.2 MB. The size, not a
// hash, is what tells them apart, because Steam replaces the file on update.
const SHIM_SIZE_MAX = 1_000_000;

const OVERRIDE_DLLS = ["dxgi", "d3d11", "d3d10core", "d3d9"];
const OVERRIDE_EXES = ["steamwebhelper.exe", "steamwebhelper_real.exe"];

const MARKER = "drive_c/MacForge/steam-fix.json";

const STEAM_CFG = "BootStrapperInhibitAll=enable\n";

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
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
 * Put the shim in place and keep the real helper beside it. Steam's
 * bootstrapper can restore its own file, so this runs before every launch: a
 * helper that is too big to be the shim is Steam's, and is moved aside again.
 */
function installShim(cef) {
  const helper = path.join(cef, "steamwebhelper.exe");
  const real = path.join(cef, "steamwebhelper_real.exe");

  if (!existsSync(SHIM)) return { ok: false, detail: "the shim is missing from the app bundle" };

  const helperSize = sizeOf(helper);
  let changed = false;

  if (helperSize > SHIM_SIZE_MAX) {
    // Steam's own file: keep it as the real helper and put the shim in front.
    try {
      rmSync(real, { force: true });
      renameSync(helper, real);
      changed = true;
    } catch (error) {
      return { ok: false, detail: `could not move the helper aside: ${error.message}` };
    }
  } else if (existsSync(helper)) {
    return { ok: true, changed: false, detail: "shim already in place" };
  }

  if (!existsSync(real)) {
    return { ok: false, detail: "the real steamwebhelper is missing" };
  }

  try {
    copyFileSync(SHIM, helper);
  } catch (error) {
    return { ok: false, detail: `could not write the shim: ${error.message}` };
  }

  return { ok: true, changed, detail: changed ? "shim installed" : "shim restored" };
}

/** Stop the bootstrapper from undoing the shim, keeping any other settings. */
function writeSteamCfg(steam) {
  const file = path.join(steam, "steam.cfg");

  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // No file yet.
  }

  const kept = current
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*BootStrapperInhibitAll\s*=/i.test(line));

  const next = [...kept, STEAM_CFG.trim()].join("\n") + "\n";
  if (next === current) return false;

  try {
    writeFileSync(file, next);
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

  const result = await run(
    prefix,
    "C:\\windows\\system32\\reg.exe",
    ["import", "C:\\MacForge\\steam-fix.reg"],
    120_000,
  );

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
 * Make Steam's sign-in window draw in this bottle. Safe to call before every
 * launch: the expensive part runs once per prefix, the rest are file checks.
 */
export async function applySteamFix(prefix) {
  const steam = steamDir(prefix);
  if (!steam) return { ok: false, detail: "no Steam install in this bottle" };

  const cef = path.join(steam, "bin", "cef", "cef.win64");
  if (!existsSync(cef)) return { ok: false, detail: "Steam's CEF folder is not there yet" };

  const shim = installShim(cef);
  const cfg = writeSteamCfg(steam);

  let overrides = { ok: true, done: 0, failed: [], cached: true };
  if (!markerMatches(prefix)) {
    overrides = { ...(await installOverrides(prefix)), cached: false };
    if (overrides.ok) writeMarker(prefix);
  }

  const parts = [shim.detail];
  if (cfg) parts.push("steam.cfg written");
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

