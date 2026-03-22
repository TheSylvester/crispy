/**
 * Platform-specific VSIX packager
 *
 * Prunes native dependencies to keep only the target platform's binaries,
 * strips CUDA/TensorRT providers (voice uses CPU only), and removes dead
 * weight from @huggingface/transformers before running `vsce package --target`.
 *
 * All pruning is done by temporarily moving files out of node_modules into a
 * staging directory, then restoring them after packaging. This is necessary
 * because vsce's .vscodeignore uses flat ignore/negate groups (not sequential
 * cascading like .gitignore), so you can't negate-include a directory and then
 * re-exclude files within it.
 *
 * Usage: node scripts/package-vsix.mjs <target>
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const TARGET_CONFIG = {
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'win32-x64': { platform: 'win32', arch: 'x64' },
  'win32-arm64': { platform: 'win32', arch: 'arm64' },
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  fail('Usage: node scripts/package-vsix.mjs <target>');
}

const config = TARGET_CONFIG[target];
if (!config) {
  fail(
    `Unsupported target "${target}". Supported targets: ${Object.keys(TARGET_CONFIG).join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const cwd = process.cwd();
const nm = join(cwd, 'node_modules');

const napiDir = join(nm, 'onnxruntime-node', 'bin', 'napi-v3');
const ortScriptDir = join(nm, 'onnxruntime-node', 'script');
const hfDir = join(nm, '@huggingface', 'transformers');
const hfSrcDir = join(hfDir, 'src');
const hfDistDir = join(hfDir, 'dist');
const hfTypesDir = join(hfDir, 'types');
const hfCacheDir = join(hfDir, '.cache');
const sharpDir = join(nm, 'sharp');
const imgDir = join(nm, '@img');
const ignoreFile = join(cwd, '.vscodeignore');

// Temp dir for stashing files we want to exclude from the VSIX
const stash = mkdtempSync(join(tmpdir(), 'crispy-pkg-'));
const stashNapi = join(stash, 'napi-v3');
const stashOrtScript = join(stash, 'ort-script');
const stashHfSrc = join(stash, 'hf-src');
const stashHfTypes = join(stash, 'hf-types');
const stashHfCache = join(stash, 'hf-cache');
const stashHfDist = join(stash, 'hf-dist-pruned');
const stashSharp = join(stash, 'sharp-real');
const stashImg = join(stash, 'img-real');
const stashIgnore = join(stash, '.vscodeignore.bak');
const stashPkgJson = join(stash, 'package.json.bak');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Move a directory from src to dest (rename if same fs, copy+rm otherwise). */
function moveDir(src, dest) {
  if (!existsSync(src)) return false;
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
  return true;
}

/** Move a single file. */
function moveFile(src, dest) {
  if (!existsSync(src)) return false;
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest);
    rmSync(src, { force: true });
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. Prune onnxruntime-node: keep only target platform, strip CUDA/TensorRT
// ---------------------------------------------------------------------------

if (existsSync(napiDir)) {
  // Move ALL platform dirs out, then copy back only the target
  moveDir(napiDir, stashNapi);
  const targetSrc = join(stashNapi, config.platform, config.arch);
  const targetDest = join(napiDir, config.platform, config.arch);
  if (existsSync(targetSrc)) {
    cpSync(targetSrc, targetDest, { recursive: true });
  }
}

// Remove CUDA/TensorRT providers (CPU-only voice inference)
const targetBinDir = join(napiDir, config.platform, config.arch);
if (existsSync(targetBinDir)) {
  for (const file of readdirSync(targetBinDir)) {
    if (/cuda|tensorrt|providers_shared/i.test(file)) {
      rmSync(join(targetBinDir, file), { force: true });
      console.log(`  Pruned: ${file}`);
    }
  }
}

// Stash onnxruntime-node/script/ (install scripts, not needed at runtime)
if (existsSync(ortScriptDir)) {
  moveDir(ortScriptDir, stashOrtScript);
}

// ---------------------------------------------------------------------------
// 2. Prune @huggingface/transformers: keep only the Node.js CJS runtime
// ---------------------------------------------------------------------------
// The extension uses --external:@huggingface/transformers, so it loads from
// node_modules at runtime via require() → resolves to dist/transformers.node.cjs.
// Everything else is dead weight:
//   - src/         (1.8 MB)  — source files, not used at runtime
//   - dist/*.wasm  (21 MB)   — WASM backend, voice uses native onnxruntime-node
//   - dist/*.js    (browser) — not needed in Node.js
//   - dist/*.map   (sourcemaps)

// Stash src/, types/, .cache/ dirs (not needed at runtime)
if (existsSync(hfSrcDir)) moveDir(hfSrcDir, stashHfSrc);
if (existsSync(hfTypesDir)) moveDir(hfTypesDir, stashHfTypes);
if (existsSync(hfCacheDir)) moveDir(hfCacheDir, stashHfCache);

// Prune dist/ — stash files we don't need, keep only Node.js CJS files
if (existsSync(hfDistDir)) {
  const keep = /^transformers\.node\.(cjs|mjs)$/; // Keep CJS + ESM node builds
  for (const file of readdirSync(hfDistDir)) {
    if (!keep.test(file)) {
      const src = join(hfDistDir, file);
      const dest = join(stashHfDist, file);
      moveFile(src, dest);
      console.log(`  Pruned: @huggingface/transformers/dist/${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Replace sharp with a stub (voice doesn't use image processing)
// ---------------------------------------------------------------------------
// sharp is a hard dependency of @huggingface/transformers but voice only uses
// audio pipelines. Stash the real 50 MB sharp + @img and replace with a tiny
// stub that exports a truthy no-op so `if (sharp)` passes in image.js.

if (existsSync(sharpDir)) {
  moveDir(sharpDir, stashSharp);
}
if (existsSync(imgDir)) {
  moveDir(imgDir, stashImg);
}

// Write stub sharp — version must match package-lock.json to pass npm list
const lockfile = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
const sharpVersion = lockfile.packages?.['node_modules/sharp']?.version ?? '0.34.2';
mkdirSync(sharpDir, { recursive: true });
writeFileSync(join(sharpDir, 'package.json'), JSON.stringify({
  name: 'sharp', version: sharpVersion, main: 'index.js',
}) + '\n');
writeFileSync(join(sharpDir, 'index.js'), `function s(){var c={metadata:async()=>({channels:0}),rotate:()=>c,raw:()=>c,toBuffer:async()=>({data:new Uint8Array(0),info:{width:0,height:0,channels:0}})};return c}module.exports=s;module.exports.default=s;\n`);
console.log('  Replaced: sharp → stub (voice uses onnxruntime-node, not sharp)');

// ---------------------------------------------------------------------------
// 4. Strip "files" field from package.json (conflicts with .vscodeignore)
// ---------------------------------------------------------------------------
// npm uses "files" for tarball inclusion; vsce uses .vscodeignore. Both cannot
// coexist. Temporarily remove "files" for the vsce run, restore after.

const pkgJsonPath = join(cwd, 'package.json');
const pkgJsonRaw = readFileSync(pkgJsonPath, 'utf8');
cpSync(pkgJsonPath, stashPkgJson);

const pkgJson = JSON.parse(pkgJsonRaw);
if (pkgJson.files) {
  delete pkgJson.files;
  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  console.log('  Stripped: "files" field from package.json (vsce uses .vscodeignore)');
}

// ---------------------------------------------------------------------------
// 5. Augment .vscodeignore
// ---------------------------------------------------------------------------

const baseIgnore = readFileSync(ignoreFile, 'utf8').trimEnd();
cpSync(ignoreFile, stashIgnore);

const ignoreSuffix = [
  '',
  '# ── Target-specific pruning (auto-generated by package-vsix.mjs) ──',
  'node_modules/onnxruntime-node/script/**',
];
writeFileSync(ignoreFile, `${baseIgnore}\n${ignoreSuffix.join('\n')}\n`);

// ---------------------------------------------------------------------------
// 6. Package
// ---------------------------------------------------------------------------

try {
  const vsceBin = process.platform === 'win32'
    ? 'node_modules\\.bin\\vsce.cmd'
    : './node_modules/.bin/vsce';

  const result = spawnSync(
    vsceBin,
    ['package', '--target', target],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  // ── Restore everything ──────────────────────────────────────────────
  // Always restore, even on failure, so node_modules isn't left broken.

  // Restore package.json (with "files" field)
  cpSync(stashPkgJson, pkgJsonPath);

  // Restore .vscodeignore
  cpSync(stashIgnore, ignoreFile);

  // Restore onnxruntime-node napi-v3 (all platforms)
  if (existsSync(stashNapi)) {
    rmSync(napiDir, { recursive: true, force: true });
    moveDir(stashNapi, napiDir);
  }

  // Restore onnxruntime-node script dir
  if (existsSync(stashOrtScript)) {
    moveDir(stashOrtScript, ortScriptDir);
  }

  // Restore @huggingface/transformers stashed dirs
  if (existsSync(stashHfSrc)) moveDir(stashHfSrc, hfSrcDir);
  if (existsSync(stashHfTypes)) moveDir(stashHfTypes, hfTypesDir);
  if (existsSync(stashHfCache)) moveDir(stashHfCache, hfCacheDir);

  // Restore @huggingface/transformers dist/ pruned files
  if (existsSync(stashHfDist)) {
    for (const file of readdirSync(stashHfDist)) {
      moveFile(join(stashHfDist, file), join(hfDistDir, file));
    }
  }

  // Restore sharp (replace stub with real package)
  rmSync(sharpDir, { recursive: true, force: true });
  if (existsSync(stashSharp)) moveDir(stashSharp, sharpDir);
  if (existsSync(stashImg)) moveDir(stashImg, imgDir);

  // Clean up temp dir
  rmSync(stash, { recursive: true, force: true });
}
