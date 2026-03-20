/**
 * Tests for Activity Index
 *
 * Tests the SQLite-backed persistence layer:
 * - ensureCrispyDir
 * - Session lineage and title management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import {
  ensureCrispyDir,
  _setTestDir,
} from '../src/core/activity-index.js';
import { _resetDb } from '../src/core/crispy-db.js';

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;
let cleanup: () => void;

beforeEach(() => {
  // Create isolated temp directory for each test
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-test-'));
  cleanup = _setTestDir(testDir);
});

afterEach(() => {
  cleanup();
  // Clean up temp directory
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ============================================================================
// ensureCrispyDir
// ============================================================================

describe('ensureCrispyDir', () => {
  it('creates directory if it does not exist', () => {
    // Close the DB before removing the directory — on Windows, open handles
    // cause ENOTEMPTY/EPERM even with maxRetries.
    _resetDb();
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    expect(fs.existsSync(testDir)).toBe(false);

    ensureCrispyDir();
    expect(fs.existsSync(testDir)).toBe(true);
  });

  it('is idempotent when directory exists', () => {
    ensureCrispyDir();
    ensureCrispyDir();
    expect(fs.existsSync(testDir)).toBe(true);
  });
});
