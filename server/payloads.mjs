import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { APP_SUPPORT, run } from "./runtime.mjs";

/**
 * The parts of a Windows prefix that Whisky supplied but a bare Wine tree does
 * not: the DXVK/DXMT DLL payloads and the Visual C++ runtimes most store games
 * link against.
 *
 * A bottle Whisky made already has both — its prefix carries DXVK in system32
 * and per-program overrides in the registry. A bottle this app builds from its
 * own runtime starts with neither, so games in it would either fall back to
 * Wine's slow wined3d or fail to start at all. This module closes that gap and
 * keeps the payloads in this app's own folder, so deleting Whisky does not take
 * the DLLs with it.
 */

export const PAYLOADS = path.join(APP_SUPPORT, "payloads");

const GRAPHICS = ["dxvk", "dxmt"];

// Whisky (both forks) keeps the payloads beside its Wine trees.
const WHISKY_LIBRARIES = [
  path.join(homedir(), "Library/Application Support/com.franke.Whisky/Libraries"),
  path.join(homedir(), "Library/Application Support/com.isaacmarovitz.Whisky/Libraries"),
];

const BOTTLE_ROOTS = [
  path.join(homedir(), "Library/Containers/com.franke.Whisky/Bottles"),
  path.join(homedir(), "Library/Containers/com.isaacmarovitz.Whisky/Bottles"),
  path.join(APP_SUPPORT, "Bottles"),
];

const STEAM_COMMON = [
  "drive_c/Program Files (x86)/Steam/steamapps/common/Steamworks Shared/_CommonRedist",
  "drive_c/Program Files/Steam/steamapps/common/Steamworks Shared/_CommonRedist",
];

// Used only when no bottle on this Mac already carries Steam's copy.
const VCREDIST_URLS = {
  "vc_redist.x64.exe": "https://aka.ms/vs/17/release/vc_redist.x64.exe",
  "vc_redist.x86.exe": "https://aka.ms/vs/17/release/vc_redist.x86.exe",
};

// Wine's load order is builtin-first for its own DLLs, so the copies alone do
// nothing: Whisky's prefixes carry exactly these overrides ("n,b" = native,
// then builtin) and this writes the same ones prefix-wide.
const OVERRIDE_DLLS = ["d3d8", "d3d9", "d3d10core", "d3d11", "dxgi"];

/**
 * Whisky's DXVK folder is incomplete here: its x64 side has no `dxgi.dll` and
 * no `d3d9.dll`, so a bottle built from it could only override three DLLs and
 * every D3D9 game fell back to Wine's builtin renderer. This is the release the
 * app installs instead — pinned, with the digest GitHub reports for the asset,
 * so the download is checked rather than trusted.
 */
const DXVK_RELEASE = {
  version: "2.7.1",
  url: "https://github.com/doitsujin/dxvk/releases/download/v2.7.1/dxvk-2.7.1.tar.gz",
  sha256: "d85ce7c79f57ecd765aaa1b9e7007cb875e6fde9f6d331df799bce73d513ce87",
  files: ["d3d8", "d3d9", "d3d10core", "d3d11", "dxgi"],
};

const REDIST_DIR = path.join(PAYLOADS, "redist");
const REDIST_MANIFEST = path.join(REDIST_DIR, "manifest.json");

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function filesIn(dir) {
  try {
    return readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile());
  } catch {
    return [];
  }
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

/** Take the payloads into this app's folder the first time, before Whisky goes. */
export function adoptGraphics() {
  const adopted = {};
  for (const kind of GRAPHICS) {
    const own = path.join(PAYLOADS, kind);
    adopted[kind] = existsSync(path.join(own, "x64"));
    if (adopted[kind]) continue;

    for (const library of WHISKY_LIBRARIES) {
      const source = path.join(library, kind === "dxvk" ? "DXVK" : "DXMT");
      if (!existsSync(path.join(source, "x64"))) continue;
      try {
        copyTree(source, own);
        adopted[kind] = true;
        break;
      } catch {
        // A half-copied payload is retried on the next call.
      }
    }
  }
  return adopted;
}

/** Which of the complete DXVK set is absent from the payload, as "arch/file". */
function dxvkMissing() {
  const missing = [];
  for (const arch of ["x64", "x32"]) {
    for (const dll of DXVK_RELEASE.files) {
      const file = path.join(PAYLOADS, "dxvk", arch, `${dll}.dll`);
      if (!existsSync(file) || statSync(file).size < 10_000) missing.push(`${arch}/${dll}.dll`);
    }
  }
  return missing;
}

function payloadVersion() {
  try {
    return readFileSync(path.join(PAYLOADS, "dxvk", "VERSION"), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Make sure the payload holds the whole DXVK set, completing it from the pinned
 * release when Whisky's copy (or a previous partial install) falls short. The
 * verified archive is kept, so this is a copy rather than a download after the
 * first time.
 */
export function ensureDxvkPayload() {
  const missing = dxvkMissing();
  if (!missing.length) {
    const version = payloadVersion() ?? "unknown";
    return { ok: true, version, detail: `DXVK ${version} · ${DXVK_RELEASE.files.length} DLLs for x64 and x32` };
  }

  const cache = path.join(PAYLOADS, ".cache", path.basename(DXVK_RELEASE.url));

  try {
    if (!existsSync(cache) || sha256(cache) !== DXVK_RELEASE.sha256) {
      mkdirSync(path.dirname(cache), { recursive: true });
      execFileSync("/usr/bin/curl", ["-fL", "--retry", "2", "-o", cache, DXVK_RELEASE.url], {
        timeout: 300_000,
        stdio: "ignore",
      });
      const got = sha256(cache);
      if (got !== DXVK_RELEASE.sha256) {
        return { ok: false, detail: `DXVK download failed its digest check (${got?.slice(0, 12) ?? "no hash"}…)` };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `could not download DXVK ${DXVK_RELEASE.version}: ${message.slice(0, 160)}` };
  }

  const work = mkdtempSync(path.join(tmpdir(), "dxvk-"));
  try {
    execFileSync("/usr/bin/tar", ["-xzf", cache, "-C", work], { timeout: 120_000, stdio: "ignore" });
    const root = path.join(work, `dxvk-${DXVK_RELEASE.version}`);

    for (const arch of ["x64", "x32"]) {
      const from = path.join(root, arch);
      const to = path.join(PAYLOADS, "dxvk", arch);
      mkdirSync(to, { recursive: true });
      for (const file of filesIn(from)) {
        if (!/\.dll$/i.test(file)) continue;
        copyFileSync(path.join(from, file), path.join(to, file));
      }
    }

    const conf = path.join(root, "dxvk.conf");
    if (existsSync(conf)) copyFileSync(conf, path.join(PAYLOADS, "dxvk", "dxvk.conf"));
    writeFileSync(path.join(PAYLOADS, "dxvk", "VERSION"), `${DXVK_RELEASE.version}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `could not unpack DXVK ${DXVK_RELEASE.version}: ${message.slice(0, 160)}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const still = dxvkMissing();
  return still.length
    ? { ok: false, detail: `unpacked DXVK ${DXVK_RELEASE.version} but still missing ${still.join(", ")}` }
    : {
        ok: true,
        version: DXVK_RELEASE.version,
        detail: `DXVK ${DXVK_RELEASE.version} · complete set taken from the release (${missing.length} files were missing)`,
      };
}

/** The self-test's own view: a partial payload is a failure, not a detail. */
export function payloadSelfTest() {
  const missing = dxvkMissing();
  const version = payloadVersion() ?? "unknown";

  return [
    {
      id: "dxvk-payload",
      label: "DXVK payload",
      ok: missing.length === 0,
      detail: missing.length
        ? `incomplete · missing ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}`
        : `DXVK ${version} · ${DXVK_RELEASE.files.join(", ")} for x64 and x32`,
    },
  ];
}

/** Steam's own copy of the VC++ installers, from whichever bottle has one. */
function localRedistSource() {
  for (const root of BOTTLE_ROOTS) {
    for (const bottle of subdirs(root)) {
      for (const relative of STEAM_COMMON) {
        const base = path.join(bottle, relative);
        for (const version of ["2022", "2019"]) {
          const dir = path.join(base, "vcredist", version);
          if (existsSync(path.join(dir, "VC_redist.x64.exe"))) return dir;
          if (existsSync(path.join(dir, "vc_redist.x64.exe"))) return dir;
        }
      }
    }
  }
  return null;
}

function sha256(file) {
  try {
    return execFileSync("/usr/bin/shasum", ["-a", "256", file], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[0];
  } catch {
    return null;
  }
}

/**
 * Put both VC++ installers in this app's payload folder. Steam's copy is used
 * when a bottle has one; otherwise they come from Microsoft's stable links, and
 * the digest of what was fetched is recorded so a later reuse is verified.
 */
function ensureRedist() {
  mkdirSync(REDIST_DIR, { recursive: true });

  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(REDIST_MANIFEST, "utf8"));
  } catch {
    manifest = {};
  }

  const missing = [];
  for (const name of Object.keys(VCREDIST_URLS)) {
    const target = path.join(REDIST_DIR, name);
    if (existsSync(target)) continue;
    missing.push(name);
  }
  if (!missing.length) return { ok: true, source: "cache" };

  const local = localRedistSource();
  let source = "cache";

  for (const name of missing) {
    const target = path.join(REDIST_DIR, name);

    if (local) {
      const candidate = filesIn(local).find((file) => file.toLowerCase() === name.toLowerCase());
      if (candidate) {
        copyFileSync(path.join(local, candidate), target);
        source = "steam";
        manifest[name] = { url: null, from: path.join(local, candidate), sha256: sha256(target) };
        continue;
      }
    }

    try {
      execFileSync("/usr/bin/curl", ["-fL", "--retry", "2", "-o", target, VCREDIST_URLS[name]], {
        timeout: 240_000,
        stdio: "ignore",
      });
      source = "download";
      manifest[name] = { url: VCREDIST_URLS[name], sha256: sha256(target) };
    } catch {
      return { ok: false, source, detail: "no VC++ installer on disk and the download failed" };
    }
  }

  manifest.updatedAt = new Date().toISOString();
  writeFileSync(REDIST_MANIFEST, JSON.stringify(manifest, null, 2));
  return { ok: true, source };
}

/** Copy DXVK (or DXMT) into the prefix and set the overrides that make it load. */
export async function installGraphics(prefix, kind = "dxvk") {
  const source = path.join(PAYLOADS, kind);
  if (!existsSync(path.join(source, "x64"))) {
    return { id: "graphics", ok: false, optional: true, detail: `no ${kind.toUpperCase()} payload available` };
  }

  const targets = [
    { arch: "x64", dir: path.join(prefix, "drive_c/windows/system32") },
    { arch: "x32", dir: path.join(prefix, "drive_c/windows/syswow64") },
  ];

  const copied = [];
  for (const { arch, dir } of targets) {
    if (!existsSync(dir)) continue;
    for (const file of filesIn(path.join(source, arch))) {
      if (!/\.dll$/i.test(file)) continue;
      copyFileSync(path.join(source, arch, file), path.join(dir, file));
      copied.push(file.replace(/\.dll$/i, "").toLowerCase());
    }
  }

  if (!copied.length) {
    return { id: "graphics", ok: false, optional: true, detail: `no DLLs in the ${kind} payload` };
  }

  const overridden = [];
  for (const dll of OVERRIDE_DLLS) {
    if (!copied.includes(dll)) continue;
    const result = await run(
      prefix,
      "C:\\windows\\system32\\reg.exe",
      ["add", "HKCU\\Software\\Wine\\DllOverrides", "/v", dll, "/d", "n,b", "/f"],
      60_000,
    );
    if (!result.ok) {
      return {
        id: "graphics",
        ok: false,
        optional: true,
        detail: `copied ${copied.length} DLLs but reg.exe failed for ${dll}: ${(result.stderr || "").trim().slice(0, 160)}`,
      };
    }
    overridden.push(dll);
  }

  return {
    id: "graphics",
    ok: overridden.length > 0,
    detail: `${kind.toUpperCase()} ${copied.length} DLLs · ${overridden.length} overrides`,
  };
}

/** Run both VC++ installers inside the prefix; they are quiet and idempotent. */
export async function installRedist(prefix) {
  const cache = ensureRedist();
  if (!cache.ok) {
    return { id: "redist", ok: false, optional: true, detail: cache.detail ?? "no installer" };
  }

  const staging = path.join(prefix, "drive_c/whisky-games/redist");
  mkdirSync(staging, { recursive: true });

  const done = [];
  for (const name of Object.keys(VCREDIST_URLS)) {
    const file = path.join(REDIST_DIR, name);
    if (!existsSync(file)) continue;
    copyFileSync(file, path.join(staging, name));

    // 1638 = a newer version is installed, 3010 = reboot wanted; both are fine
    // for a bottle, which never reboots.
    const result = await run(
      prefix,
      `C:\\whisky-games\\redist\\${name}`,
      ["/install", "/quiet", "/norestart"],
      600_000,
    );
    if (result.ok || [1638, 194, 3010].includes(result.code)) done.push(name.replace(/\..*$/, ""));
    else {
      return {
        id: "redist",
        ok: false,
        optional: true,
        detail: `${name} exited ${result.code ?? "?"}: ${(result.stderr || "").trim().slice(0, 160)}`,
      };
    }
  }

  return {
    id: "redist",
    ok: done.length > 0,
    detail: done.length ? `installed ${done.join(" + ")} (${cache.source})` : "no installers to run",
  };
}

/**
 * Everything a fresh bottle needs to behave like a Whisky-made one. Each step is
 * reported separately, and the graphics/redist steps are optional in the sense
 * that a failure is recorded rather than throwing away a working prefix.
 */
export async function prepareBottle(prefix) {
  const adopted = adoptGraphics();
  const payload = ensureDxvkPayload();
  const steps = [
    { id: "dxvk-payload", ok: payload.ok, detail: payload.detail },
    await installGraphics(prefix, "dxvk"),
    await installRedist(prefix),
  ];

  try {
    mkdirSync(path.join(prefix, "drive_c/whisky-games"), { recursive: true });
    writeFileSync(
      path.join(prefix, "drive_c/whisky-games/prepared.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          adopted,
          steps: steps.map((step) => ({ id: step.id, ok: step.ok, detail: step.detail })),
        },
        null,
        2,
      ),
    );
  } catch {
    // The marker is bookkeeping; the prefix still works without it.
  }

  return { ok: steps.every((step) => step.ok || step.optional === true), steps };
}

/** What the payload folder holds, for /api/payloads. */
export function payloadStatus() {
  const graphics = {};
  for (const kind of GRAPHICS) {
    const dir = path.join(PAYLOADS, kind);
    graphics[kind] = existsSync(path.join(dir, "x64")) && filesIn(path.join(dir, "x64")).length > 0;
  }

  const redist = filesIn(REDIST_DIR).filter((name) => /\.exe$/i.test(name));

  const missing = dxvkMissing();

  return {
    dir: PAYLOADS,
    graphics,
    dxvk: {
      version: payloadVersion(),
      complete: missing.length === 0,
      missing,
      files: DXVK_RELEASE.files,
    },
    redist,
    ready: missing.length === 0 && redist.length > 0,
    fromWhisky: WHISKY_LIBRARIES.find((dir) => existsSync(dir)) ?? null,
  };
}
