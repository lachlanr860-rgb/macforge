import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * This app's own Wine layer.
 *
 * Whisky is no longer needed to launch anything: a runtime is a plain Wine tree
 * on disk, and the environment built here is the one Whisky's CLI printed for a
 * bottle (ESync, DXVK async, MoltenVK shader compilation, Steam's sandbox
 * flags). With the same binaries and the same environment, a launch from this
 * app is the same launch.
 *
 * DLL overrides are deliberately not set here. Whisky writes them into the
 * prefix registry (HKCU\Software\Wine\AppDefaults\<exe>\DllOverrides), which
 * Wine reads before WINEDLLOVERRIDES, and its own printed command unsets the
 * variable with `env -u WINEDLLOVERRIDES` for the same reason.
 */

export const APP_SUPPORT = path.join(homedir(), "Library", "Application Support", "MacForge");
export const OWN_BOTTLES = path.join(APP_SUPPORT, "Bottles");

const OWN_RUNTIME = path.join(APP_SUPPORT, "runtime");

const SHARED_WINE = path.join(
  homedir(),
  "Library/Application Support/com.franke.Whisky/Libraries/Wine",
);

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function usable(root) {
  return Boolean(root) && existsSync(path.join(root, "bin", "wine64"));
}

function versionOf(exe) {
  try {
    return execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

/** Where a Wine tree can come from, best first: ours, an override, then Whisky's. */
function candidates() {
  const found = [];
  if (process.env.WHISKY_GAMES_WINE) {
    found.push({ root: process.env.WHISKY_GAMES_WINE, source: "override" });
  }
  for (const dir of subdirs(OWN_RUNTIME)) {
    if (usable(dir)) found.push({ root: dir, source: "own" });
  }
  found.push({ root: SHARED_WINE, source: "shared" });
  return found;
}

let cached = { at: 0, value: null };

/**
 * The Wine tree this app will use. Reading the version costs a process launch,
 * so the answer is kept for a minute; pass true to look again now.
 */
export function runtime(force = false) {
  if (!force && cached.value && Date.now() - cached.at < 60_000) return cached.value;

  let value = { ok: false, root: null, exe: null, wineserver: null, wineboot: null, source: null, version: null };

  for (const option of candidates()) {
    if (!usable(option.root)) continue;
    const exe = path.join(option.root, "bin", "wine64");
    value = {
      ok: true,
      root: option.root,
      exe,
      wineserver: path.join(option.root, "bin", "wineserver"),
      source: option.source,
      version: versionOf(exe),
    };
    break;
  }

  cached = { at: Date.now(), value };
  return value;
}

/** The environment Whisky would hand Wine, without Whisky. */
export function wineEnv(prefix, extra = {}) {
  const env = { ...process.env };

  // The prefix registry owns DLL overrides; leaving the variable set would
  // shadow per-program ones, which is the bug Whisky's own CLI fixed.
  delete env.WINEDLLOVERRIDES;
  delete env.WINEPREFIX;

  Object.assign(env, {
    WINEPREFIX: prefix,
    WINEESYNC: "1",
    WINEFSYNC: "0",
    WINEDEBUG: "fixme-all",
    DXVK_ASYNC: "1",
    CEF_DISABLE_SANDBOX: "1",
    STEAM_RUNTIME: "0",
    STEAM_DISABLE_CEF_SANDBOX: "1",
    MVK_CONFIG_SHOULD_MAXIMIZE_CONCURRENT_COMPILATION: "1",
    MESA_GL_VERSION_OVERRIDE: "4.6",
    MESA_GLSL_VERSION_OVERRIDE: "460",
    MTL_DEBUG_LAYER: "0",
    TZ: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }, extra);

  return env;
}

/** C:\Program Files (x86)\Steam\steam.exe → <prefix>/drive_c/Program Files (x86)/Steam/steam.exe */
export function unixFor(prefix, windowsPath) {
  const match = /^([a-z]):(.*)$/i.exec(windowsPath ?? "");
  if (!match) return null;
  const drive = path.join(prefix, `drive_${match[1].toLowerCase()}`);
  return path.join(drive, ...match[2].split(/[\\/]+/).filter(Boolean));
}

/**
 * Run a program the way Whisky does and let go of it: Wine's `start /unix`
 * hands the program to wineserver, so the app is not its parent and closing
 * this process never takes a game down with it.
 */
export function launch(prefix, windowsExe, args = []) {
  const rt = runtime();
  const exe = unixFor(prefix, windowsExe);
  if (!rt.ok || !exe) return null;

  const child = spawn(rt.exe, ["start", "/unix", exe, ...args], {
    env: wineEnv(prefix),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

/** Run a program and wait for it, keeping its output. */
export function run(prefix, windowsExe, args = [], timeoutMs = 120_000) {
  const rt = runtime();
  const exe = unixFor(prefix, windowsExe);
  if (!rt.ok || !exe) return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "No Wine runtime" });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(rt.exe, [exe, ...args], { env: wineEnv(prefix), stdio: ["ignore", "pipe", "pipe"] });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\nTimed out` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, code: null, stdout, stderr: error.message }));
    child.on("exit", (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

/**
 * Build a prefix this app owns. The Wine tree carries no `wineboot` binary of
 * its own — the tool is a Windows executable inside the tree — so it is run the
 * way Wine expects: `wine64 wineboot -i`. wineserver -w then waits until the
 * prefix is written out rather than leaving half-built files behind.
 */
export async function createBottle(dir) {
  const rt = runtime();
  if (!rt.ok) return { ok: false, error: "No Wine runtime to build a bottle with" };
  if (existsSync(path.join(dir, "drive_c"))) return { ok: true, dir, created: false };

  mkdirSync(dir, { recursive: true });

  const boot = await run(dir, "C:\\windows\\system32\\wineboot.exe", ["-i"], 300_000);

  try {
    execFileSync(rt.wineserver, ["-w"], { env: wineEnv(dir), stdio: "ignore", timeout: 60_000 });
  } catch {
    // wineboot already returned; waiting is only belt and braces.
  }

  const built = existsSync(path.join(dir, "drive_c"));
  if (!built) {
    return { ok: false, dir, error: (boot.stderr || "wineboot did not create drive_c").trim().slice(0, 300) };
  }

  return { ok: true, dir, created: true, prefix: path.join(dir, "drive_c") };
}

/** Prefixes this app made itself, as opposed to ones Whisky created. */
export function ownBottles() {
  return subdirs(OWN_BOTTLES).filter((dir) => existsSync(path.join(dir, "drive_c")));
}

function dllSize(prefix, name) {
  try {
    return statSync(path.join(prefix, "drive_c", "windows", "system32", name)).size;
  } catch {
    return 0;
  }
}

/**
 * Does this runtime actually work here? Every check reports its detail, so a
 * failure says what is missing instead of just being false.
 */
export async function selfTest(prefix) {
  const rt = runtime(true);
  const wine = prefix ?? ownBottles()[0] ?? null;
  const checks = [];

  checks.push({
    id: "wine",
    label: "Wine binary",
    ok: rt.ok,
    detail: rt.ok ? `${rt.version ?? "unknown version"} · ${rt.exe.replace(homedir(), "~")}` : "No Wine tree found",
  });

  checks.push({
    id: "wineserver",
    label: "wineserver",
    ok: Boolean(rt.wineserver && existsSync(rt.wineserver)),
    detail: rt.wineserver ? rt.wineserver.replace(homedir(), "~") : "missing",
  });

  checks.push({
    id: "moltenvk",
    label: "MoltenVK",
    ok: Boolean(rt.root && existsSync(path.join(rt.root, "lib", "libMoltenVK.dylib"))),
    detail: rt.root ? path.join(rt.root, "lib", "libMoltenVK.dylib").replace(homedir(), "~") : "missing",
  });

  const d3d11 = wine ? dllSize(wine, "d3d11.dll") : 0;
  checks.push({
    id: "dxvk",
    label: "DXVK in prefix",
    ok: d3d11 > 1_000_000,
    detail: wine ? `${path.basename(wine)} · d3d11.dll ${Math.round(d3d11 / 1024)} KB` : "no prefix to check",
  });

  if (rt.ok && wine) {
    const attempt = () => run(wine, "C:\\windows\\system32\\cmd.exe", ["/c", "echo", "wine-ok"], 60_000);
    let round = await attempt();
    let echoed = /wine-ok/.test(round.stdout);

    // The first launch after a runtime switch makes Wine upgrade the prefix, and
    // that run can exit non-zero before the program starts. One retry separates
    // that from a runtime that genuinely cannot launch anything.
    if (!echoed) {
      round = await attempt();
      echoed = /wine-ok/.test(round.stdout);
    }

    checks.push({
      id: "roundtrip",
      label: "Program launch",
      ok: echoed,
      detail: echoed
        ? `cmd.exe ran inside the prefix${round.code ? ` (exit ${round.code})` : ""}`
        : (round.stderr || "did not finish").trim().slice(0, 200),
    });
  } else {
    checks.push({
      id: "roundtrip",
      label: "Program launch",
      ok: false,
      detail: "needs a runtime and a prefix",
    });
  }

  return { healthy: checks.every((check) => check.ok), checks, prefix: wine };
}

/** The shape /api/runtime serves: facts, no process launches beyond the version. */
export function info() {
  const rt = runtime();
  const own = ownBottles();
  return {
    ok: rt.ok,
    version: rt.version,
    source: rt.source,
    exe: rt.exe,
    root: rt.root,
    wineserver: rt.wineserver,
    own: {
      bottleKinds: own.length,
      dirs: own.map((dir) => ({ name: path.basename(dir), dir })),
      bottles: path.join(APP_SUPPORT, "Bottles"),
      runtime: path.join(APP_SUPPORT, "runtime"),
    },
    whiskyCli: "/Applications/Whisky.app/Contents/Resources/WhiskyCmd",
  };
}
