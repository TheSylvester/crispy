#!/usr/bin/env node
/**
 * Generate `src/generated/sdk-version.ts` from the installed
 * `@anthropic-ai/claude-agent-sdk/package.json`.
 *
 * Crispy overrides `pathToClaudeCodeExecutable` with the user's system
 * `claude` binary, so the SDK's bundled CLI is bypassed. The SDK's
 * `package.json` carries `claudeCodeVersion` — the CLI version it was
 * built against. We bake that into a committed TypeScript constant so
 * runtime code can warn when the user's system CLI is older than the
 * SDK expects.
 *
 * Why a generator (and not `require('@anthropic-ai/claude-agent-sdk/package.json')`):
 *   the SDK's `exports` map doesn't export `./package.json`, so a runtime
 *   require fails when the SDK is externalized (dev server, CLI entry).
 *   A committed generated constant is identical across all build targets.
 *
 * Why committed (and not gitignored):
 *   `npm run dev` and `npm run test:unit` don't run build/typecheck,
 *   so a gitignored generated file would be missing in hot paths.
 *   `src/core/adapters/codex/protocol/*.ts` is committed-generated precedent.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outputPath = join(repoRoot, 'src', 'generated', 'sdk-version.ts');

function resolveSdkPackageJson(): string {
  // Resolve the SDK entrypoint, then walk up to its package.json.
  const entry = require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [repoRoot] });
  // entry like: <repo>/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
  // package.json sits next to it or a level up; search upward.
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
      if (pkg.name === '@anthropic-ai/claude-agent-sdk') return candidate;
    } catch {
      // continue
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate @anthropic-ai/claude-agent-sdk/package.json');
}

const pkgPath = resolveSdkPackageJson();
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { claudeCodeVersion?: string };
const version = pkg.claudeCodeVersion;

if (!version || typeof version !== 'string') {
  throw new Error(`@anthropic-ai/claude-agent-sdk package.json has no "claudeCodeVersion" field (found: ${JSON.stringify(version)})`);
}

const contents = `// GENERATED — do not edit. Run \`npm run generate:sdk-version\`.
// Source: @anthropic-ai/claude-agent-sdk's package.json "claudeCodeVersion".
export const EXPECTED_CLI_VERSION = '${version}';
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, contents);
console.log(`  generated ${outputPath} (EXPECTED_CLI_VERSION=${version})`);
