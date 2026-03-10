/**
 * recall-run — Run the recall agent directly for debugging and prompt iteration.
 *
 * Bootstraps the adapter system (same as backfill.ts), then dispatches an
 * ephemeral child session with the internal MCP server attached. Vendor-agnostic:
 * works with Claude, Codex, GLM, or any registered adapter.
 *
 * Usage:
 *   npx tsx scripts/recall-run.ts "your query here" [options]
 *
 * @module scripts/recall-run
 */

// Unblock nested Claude sessions — often launched from inside Claude Code
delete process.env.CLAUDECODE;

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAgentDispatch } from '../src/host/agent-dispatch.js';
import { registerAllAdapters, resolveInternalServerPaths } from '../src/host/adapter-registry.js';
import { initSettings } from '../src/core/settings/index.js';
import { parseModelOption } from '../src/core/model-utils.js';
import { buildInternalMcpConfig, buildRecallPrompt } from '../src/mcp/servers/external.js';
import { dbPath } from '../src/core/activity-index.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT = 180;

// ============================================================================
// CLI Parsing
// ============================================================================

function printUsage(): void {
  console.error(`
Usage: npx tsx scripts/recall-run.ts "your query here" [options]

Options:
  --model, -m <vendor:model>   Model to use (default: ${DEFAULT_MODEL})
                               Examples: zai:glm-4.6, codex:gpt-5.3-instant, anthropic:claude-haiku-4-5
  --timeout, -t <seconds>      Timeout in seconds (default: ${DEFAULT_TIMEOUT})
  --project-id <path>          Project path for scoping search (default: cwd)
  --prompt-file, -p <file>     Override recall prompt (use {query} placeholder)
  --verbose, -v                Print tool calls and debug info to stderr
  --help, -h                   Show this help

Examples:
  npx tsx scripts/recall-run.ts "what projects am I working on"
  npx tsx scripts/recall-run.ts "voice input implementation" --model claude-sonnet-4-5
  npx tsx scripts/recall-run.ts "all work done on MCP servers" --verbose
  npx tsx scripts/recall-run.ts "recent work" --model zai:glm-4.6
  npx tsx scripts/recall-run.ts "bug on machine two" --prompt-file alt-prompt.txt
`);
}

interface CliOptions {
  query: string;
  model: string;
  timeout: number;
  projectId: string;
  promptFile: string | undefined;
  verbose: boolean;
}

function parseCli(): CliOptions | null {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: 'string', short: 'm', default: DEFAULT_MODEL },
      timeout: { type: 'string', short: 't', default: String(DEFAULT_TIMEOUT) },
      'project-id': { type: 'string' },
      'prompt-file': { type: 'string', short: 'p' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return null;
  }

  const query = positionals[0];
  if (!query) {
    console.error('Error: query argument is required\n');
    printUsage();
    return null;
  }

  return {
    query,
    model: values.model as string,
    timeout: Math.max(1, parseInt(values.timeout as string, 10) || DEFAULT_TIMEOUT),
    projectId: (values['project-id'] as string) ?? process.cwd(),
    promptFile: values['prompt-file'] as string | undefined,
    verbose: values.verbose as boolean,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function log(msg: string): void {
  console.error(msg);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const opts = parseCli();
  if (!opts) process.exit(0);

  // Preflight: check DB exists
  const db = dbPath();
  if (!existsSync(db)) {
    log(`Error: Database not found at ${db}`);
    log('  The internal MCP server needs ~/.crispy/crispy.db to search sessions.');
    process.exit(1);
  }

  // Load prompt override if specified
  let promptOverride: string | undefined;
  if (opts.promptFile) {
    const promptPath = resolve(opts.promptFile);
    if (!existsSync(promptPath)) {
      log(`Error: Prompt file not found: ${opts.promptFile}`);
      process.exit(1);
    }
    promptOverride = readFileSync(promptPath, 'utf-8').trim();
  }

  // Bootstrap adapter system
  const cwd = process.cwd();
  const dispatch = createAgentDispatch();
  const unregister = registerAllAdapters({ cwd, hostType: 'dev-server', dispatch });
  await initSettings({ cwd });

  const { vendor, model: modelName } = parseModelOption(opts.model);
  const model = modelName || undefined;
  const serverPaths = resolveInternalServerPaths();
  const projectArgs = opts.projectId ? [`--project-id=${opts.projectId}`] : [];

  // Build prompt
  let prompt: string | Array<{ type: 'text'; text: string }>;
  if (promptOverride) {
    prompt = [{ type: 'text' as const, text: promptOverride.replace('{query}', opts.query) }];
  } else {
    prompt = buildRecallPrompt(opts.query);
  }

  // Print config to stderr
  log('--- Recall Agent ---');
  log(`  Query:      ${opts.query}`);
  log(`  Model:      ${model ?? 'default'}`);
  log(`  Vendor:     ${vendor}`);
  log(`  Timeout:    ${opts.timeout}s`);
  log(`  Project:    ${opts.projectId}`);
  if (opts.promptFile) {
    log(`  Prompt:     ${opts.promptFile}`);
  }
  log('');

  const shutdown = () => {
    dispatch.dispose();
    unregister();
  };

  process.on('SIGINT', () => {
    log('\n[recall-run] Interrupted');
    shutdown();
    process.exit(130);
  });

  const t0 = Date.now();

  try {
    const childResult = await dispatch.dispatchChild({
      parentSessionId: 'recall-run-cli',
      vendor,
      parentVendor: vendor,
      prompt,
      settings: {
        ...(model && { model }),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
      forceNew: true,
      mcpServers: buildInternalMcpConfig(serverPaths.command, serverPaths.args, projectArgs),
      env: {
        CLAUDECODE: '',
        CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(opts.timeout * 1000),
      },
      skipPersistSession: true,
      autoClose: true,
      timeoutMs: opts.timeout * 1000,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    log('\n--- Result ---');

    if (!childResult) {
      log(`  Recall agent returned null after ${elapsed}s (timeout or empty response)`);
      shutdown();
      process.exit(2);
    }

    if (opts.verbose) {
      log(`  Session: ${childResult.sessionId}`);
      log(`  Response length: ${childResult.text.length} chars`);
    }

    if (childResult.text.trim()) {
      // Answer text goes to stdout (pipeable)
      console.log(childResult.text.trim());
      log(`\n  Elapsed: ${elapsed}s`);
    } else {
      log(`  Recall agent completed but returned no text (elapsed: ${elapsed}s)`);
    }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`\nRecall agent failed after ${elapsed}s: ${err instanceof Error ? err.message : String(err)}`);
    if (opts.verbose && err instanceof Error && err.stack) {
      log(err.stack);
    }
    shutdown();
    process.exit(1);
  }

  shutdown();
}

main().catch((err) => {
  console.error('[recall-run] Fatal error:', err);
  process.exit(1);
});
