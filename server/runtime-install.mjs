import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { APP_SUPPORT, runtime } from "./runtime.mjs";

/**
 * Fetching the Wine tree this app runs games with.
 *
 * This is the same choice `scripts/fetch-runtime.mjs` makes, but as a module so
 * the app can do it on first launch instead of asking a new user to run a
 * terminal command. The archive is verified against the digest GitHub publishes,
 * extracted into runtime/, and only then renamed into place.
 */

export const RUNTIME_DIR = path.join(APP_SUPPORT, "runtime");

const GCENX = "https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=100";
const WHISKY = "https://api.github.com/repos/frankea/Whisky/releases?per_page=20";
const USER_AGENT = "MacForge/1.0";

const state = {
  running: false,
  done: false,
  already: false,
  error: null,
  phase: "idle",
  label: null,
  received: 0,
  total: 0,
  speed: 0,
};

/** What the page polls while the runtime is being fetched. */
export function runtimeInstallStatus() {
  return { ...state };
}

function reset(label = null) {
  Object.assign(state, {
    running: true,
    done: false,
    already: false,
    error: null,
    phase: "resolving",
    label,
    received: 0,
    total: 0,
    speed: 0,
  });
}

async function api(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

/**
 * A crossover build is the ideal tree — Wine plus MoltenVK and GStreamer — but
 * Gcenx has not published one in any release. The Whisky fork's Libraries
 * bundle is the same family this Mac already runs as Wine 11.19.
 */
async function pick() {
  const macTar = (asset) => /osx64\.tar\.xz$/i.test(asset.name);
  const gcenx = await api(GCENX);

  for (const release of gcenx) {
    const asset = (release.assets ?? [])
      .filter(macTar)
      .find((entry) => /wine-crossover-.*osx64\.tar\.xz$/i.test(entry.name));
    if (asset) return { label: `wine-crossover-${release.tag_name}`, url: asset.browser_download_url, digest: asset.digest };
  }

  const whisky = await api(WHISKY);
  for (const release of whisky) {
    const asset = (release.assets ?? []).find((entry) => /^Libraries\.tar\.gz$/i.test(entry.name));
    if (asset) {
      return {
        label: `wine-whiskywine-${release.tag_name}`,
        url: asset.browser_download_url,
        digest: asset.digest,
      };
    }
  }

  for (const release of gcenx) {
    const assets = (release.assets ?? []).filter(macTar);
    if (assets.length) {
      const asset = assets[0];
      return {
        label: `wine-${asset.name.replace(/\.tar\.xz$/i, "")}`,
        url: asset.browser_download_url,
        digest: asset.digest,
      };
    }
  }

  throw new Error("No macOS Wine archive found in either repository");
}

async function download(url, file) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
  });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);

  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastAt = Date.now();
  let lastBytes = 0;

  state.total = total;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastAt < 500) return;
    state.received = received;
    state.speed = Math.round((received - lastBytes) / ((now - lastAt) / 1000));
    lastAt = now;
    lastBytes = received;
  });

  await pipeline(body, createWriteStream(file));
  state.received = received;
  if (!state.total) state.total = received;
  state.speed = 0;
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** The runtime root is whichever folder inside the archive holds bin/wine64. */
function findRuntimeRoot(dir, depth = 0) {
  if (existsSync(path.join(dir, "bin", "wine64"))) return dir;
  if (depth >= 4) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findRuntimeRoot(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Install the runtime once. `archiveUrl` exists for tests and for mirrors; the
 * app itself always uses the release GitHub publishes.
 */
export async function installRuntime({ archiveUrl = process.env.MACFORGE_RUNTIME_URL || null } = {}) {
  if (state.running) return { ok: false, error: "A runtime download is already running" };

  reset(archiveUrl ? path.basename(new URL(archiveUrl).pathname) : null);

  let staging = null;
  let archive = null;

  try {
    const choice = archiveUrl
      ? {
          label: path.basename(new URL(archiveUrl).pathname).replace(/\.tar\.(xz|gz)$/i, ""),
          url: archiveUrl,
          digest: null,
        }
      : await pick();

    state.label = choice.label;
    const target = path.join(RUNTIME_DIR, choice.label);

    if (existsSync(path.join(target, "bin", "wine64"))) {
      Object.assign(state, { running: false, done: true, already: true, phase: "done" });
      return { ok: true, already: true, dir: target };
    }

    mkdirSync(RUNTIME_DIR, { recursive: true });

    const name = path.basename(new URL(choice.url).pathname);
    archive = path.join(RUNTIME_DIR, `.download-${Date.now()}-${name}`);
    state.phase = "downloading";
    await download(choice.url, archive);

    state.phase = "verifying";
    const digest = await sha256(archive);
    if (choice.digest?.startsWith("sha256:") && choice.digest.slice(7) !== digest) {
      throw new Error(`The download did not match the published digest (${digest.slice(0, 12)}…)`);
    }

    state.phase = "extracting";
    staging = path.join(RUNTIME_DIR, `.extract-${Date.now()}`);
    mkdirSync(staging, { recursive: true });
    execFileSync("tar", [/\\.tar\\.xz$/i.test(name) ? "-xJf" : "-xzf", archive, "-C", staging], {
      stdio: "ignore",
    });

    const root = findRuntimeRoot(staging);
    if (!root) throw new Error("The archive did not contain bin/wine64");

    state.phase = "installing";
    rmSync(target, { recursive: true, force: true });
    renameSync(root, target);
    rmSync(staging, { recursive: true, force: true });
    staging = null;
    rmSync(archive, { force: true });
    archive = null;

    const moltenvk = existsSync(path.join(target, "lib", "libMoltenVK.dylib"));
    if (!moltenvk) {
      throw new Error("The archive has no MoltenVK, so games could not render");
    }

    // runtime() caches its answer for a minute; make the new tree visible now.
    runtime(true);

    Object.assign(state, { running: false, done: true, phase: "done" });
    return { ok: true, dir: target };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(state, { running: false, done: false, phase: "error", error: message });
    return { ok: false, error: message };
  } finally {
    if (archive) rmSync(archive, { force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

/** Where a fresh install would put things, for the log and the page. */
export function runtimeInstallTarget() {
  return RUNTIME_DIR.replace(homedir(), "~");
}
