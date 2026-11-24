#!/usr/bin/env node
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
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Install a Wine tree this app owns, so Whisky can be deleted entirely.
 *
 *   node scripts/fetch-runtime.mjs --list           what it would install
 *   node scripts/fetch-runtime.mjs                  download and install it
 *   node scripts/fetch-runtime.mjs --url <archive>  install a specific archive
 *
 * Sources, best first:
 *   1. a Gcenx `wine-crossover-*-osx64.tar.xz`, if one is ever published again
 *   2. the `Libraries.tar.gz` from the Whisky fork's releases — the WineCX build
 *      with MoltenVK, DXVK and DXMT that Whisky itself ships, which is what this
 *      Mac already runs as Wine 11.19
 *   3. the newest Gcenx devel/staging build, with a warning: those may not
 *      carry MoltenVK, and DXVK cannot render without it
 *
 * The result lands in ~/Library/Application Support/MacForge/runtime, which
 * server/runtime.mjs prefers over Whisky's own copy. Nothing is written outside
 * that folder, and the archive is checked against the sha256 GitHub publishes
 * for the asset when it has one.
 */

const SUPPORT = path.join(homedir(), "Library", "Application Support", "MacForge");
const RUNTIME = path.join(SUPPORT, "runtime");

const GCENX = "https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=100";
const WHISKY = "https://api.github.com/repos/frankea/Whisky/releases?per_page=20";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? true;
};

function human(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function api(url) {
  const response = await fetch(url, { headers: { "User-Agent": "MacForge/1.0" } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return response.json();
}

/**
 * Pick the archive to install. A crossover build is the thing to want — it is
 * the Wine tree with MoltenVK and GStreamer — but Gcenx has not published one
 * in any of its releases, so the Whisky fork's Libraries bundle is next: same
 * family, same versions, published for exactly this purpose.
 */
async function pick() {
  const macTar = (asset) => /osx64\.tar\.xz$/i.test(asset.name);

  const gcenx = await api(GCENX);
  for (const release of gcenx) {
    const assets = (release.assets ?? []).filter(macTar);
    const asset = assets.find((entry) => /wine-crossover-.*osx64\.tar\.xz$/i.test(entry.name));
    if (asset) return { kind: "crossover", release, asset, label: `wine-crossover-${release.tag_name}` };
  }

  const whisky = await api(WHISKY);
  for (const release of whisky) {
    const asset = (release.assets ?? []).find((entry) => /^Libraries\.tar\.gz$/i.test(entry.name));
    if (asset) return { kind: "whiskywine", release, asset, label: `wine-whiskywine-${release.tag_name}` };
  }

  for (const release of gcenx) {
    const assets = (release.assets ?? []).filter(macTar);
    if (assets.length) {
      return { kind: "fallback", release, asset: assets[0], label: `wine-${assets[0].name.replace(/\.tar\.xz$/i, "")}` };
    }
  }

  throw new Error("No macOS Wine archive found in either repository");
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(url, file) {
  const response = await fetch(url, { headers: { "User-Agent": "MacForge/1.0" } });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);

  const total = Number(response.headers.get("content-length") ?? 0);
  let seen = 0;
  let last = 0;

  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    seen += chunk.length;
    const now = Date.now();
    if (now - last < 1_000) return;
    last = now;
    process.stdout.write(`\r  ${human(seen)}${total ? ` of ${human(total)}` : ""}`);
  });

  await pipeline(body, createWriteStream(file));
  process.stdout.write(`\r  ${human(seen)}${total ? ` of ${human(total)}` : ""}\n`);
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

async function main() {
  const urlOverride = flag("--url");
  const choice = urlOverride ? null : await pick();

  if (args.includes("--list")) {
    if (!choice) {
      console.log("--url given, so that archive is used as-is");
    } else if (choice.kind === "crossover") {
      console.log(`Crossover build with MoltenVK: ${choice.asset.name} · ${human(choice.asset.size)}`);
      console.log(`  from ${choice.release.tag_name}`);
    } else if (choice.kind === "whiskywine") {
      console.log(`WhiskyWine bundle with MoltenVK, DXVK and DXMT: ${choice.asset.name} · ${human(choice.asset.size)}`);
      console.log(`  from frankea/Whisky ${choice.release.tag_name} — the same build this Mac runs as Wine 11.19`);
    } else {
      console.log(`No MoltenVK build available — would install ${choice.asset.name} · ${human(choice.asset.size)}`);
      console.log("  Gcenx devel/staging builds may have no MoltenVK, and DXVK cannot render without it");
    }

    if (choice?.kind === "whiskywine") {
      const gcenx = await api(GCENX);
      console.log(`  Gcenx releases checked for a crossover build: ${gcenx.length}, none published`);
    }

    if (existsSync(RUNTIME)) {
      const dirs = readdirSync(RUNTIME, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      console.log(`\ninstalled: ${dirs.length ? dirs.map((entry) => entry.name).join(", ") : "(nothing yet)"}`);
      for (const entry of dirs) {
        const root = path.join(RUNTIME, entry.name);
        const moltenvk = existsSync(path.join(root, "lib", "libMoltenVK.dylib"));
        console.log(`  ${entry.name}: MoltenVK ${moltenvk ? "present" : "MISSING"}`);
      }
    } else {
      console.log(`\ninstalled: (nothing yet)`);
    }
    console.log(`\ntarget folder: ${RUNTIME.replace(homedir(), "~")}`);
    return;
  }

  const url = urlOverride ?? choice.asset.browser_download_url;
  const name = path.basename(new URL(url).pathname);
  const label = urlOverride ? name.replace(/\.tar\.(xz|gz)$/i, "") : choice.label;
  const target = path.join(RUNTIME, label);

  if (existsSync(path.join(target, "bin", "wine64"))) {
    console.log(`Already installed: ${target.replace(homedir(), "~")}`);
    return;
  }

  mkdirSync(RUNTIME, { recursive: true });
  const archive = path.join(RUNTIME, name);

  console.log(`Downloading ${choice ? `${choice.asset.name} (${human(choice.asset.size)})` : name}`);
  await download(url, archive);

  const digest = choice?.asset?.digest;
  const actual = await sha256(archive);
  if (digest?.startsWith("sha256:")) {
    if (digest.slice(7) !== actual) {
      rmSync(archive, { force: true });
      throw new Error(`Digest mismatch — expected ${digest.slice(7)}, got ${actual}`);
    }
    console.log("  digest verified against the release");
  } else {
    console.log(`  sha256 ${actual} (no digest published to compare against)`);
  }

  console.log("Extracting");
  const staging = path.join(RUNTIME, `.extract-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  execFileSync("tar", [/\.tar\.xz$/i.test(name) ? "-xJf" : "-xzf", archive, "-C", staging], {
    stdio: "inherit",
  });
  rmSync(archive, { force: true });

  // Libraries.tar.gz unpacks as Libraries/Wine/…; a crossover tarball as one
  // Wine tree. Both end up as a single folder directly under runtime/, because
  // that is exactly what server/runtime.mjs scans.
  const root = findRuntimeRoot(staging);
  if (!root) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error("The archive did not contain bin/wine64");
  }

  rmSync(target, { recursive: true, force: true });
  renameSync(root, target);
  rmSync(staging, { recursive: true, force: true });

  const size = statSync(path.join(target, "bin", "wine64")).size;
  const moltenvk = existsSync(path.join(target, "lib", "libMoltenVK.dylib"));
  console.log(`Installed ${target.replace(homedir(), "~")} (wine64 ${human(size)}, MoltenVK ${moltenvk ? "present" : "MISSING"})`);

  if (!moltenvk) {
    console.log("DXVK has no Vulkan driver without MoltenVK, so games will not render.");
    console.log("Install the Whisky Libraries bundle instead: node scripts/fetch-runtime.mjs");
    process.exitCode = 1;
    return;
  }

  console.log("\nserver/runtime.mjs now prefers this runtime over Whisky's copy,");
  console.log("so Whisky.app and ~/Library/Application Support/com.franke.Whisky can be deleted.");
  console.log("Check it first: start the app, then open /api/runtime — source should read \"own\".");
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
