/**
 * CLI subcommand routing tests
 *
 * Tests that `npx s402-mcp <subcommand>` routes correctly.
 * Uses child_process to spawn the actual binary — tests real behavior.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'index.js');

// Helper: run the CLI and capture stderr (all CLI output goes to stderr)
async function run(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.code ?? 1,
    };
  }
}

describe('CLI routing', () => {
  describe('help', () => {
    it('should show help with --help', async () => {
      const { stderr, code } = await run('--help');
      expect(code).toBe(0);
      expect(stderr).toContain('s402-mcp');
      expect(stderr).toContain('Commands:');
      expect(stderr).toContain('setup');
      expect(stderr).toContain('auth status');
    });

    it('should show help with help subcommand', async () => {
      const { stderr, code } = await run('help');
      expect(code).toBe(0);
      expect(stderr).toContain('Commands:');
    });

    it('should show help with -h', async () => {
      const { stderr, code } = await run('-h');
      expect(code).toBe(0);
      expect(stderr).toContain('Commands:');
    });
  });

  describe('version', () => {
    it('should show version with version subcommand', async () => {
      const { stderr, code } = await run('version');
      expect(code).toBe(0);
      expect(stderr).toMatch(/s402-mcp v\d+\.\d+\.\d+/);
    });

    it('should show version with --version', async () => {
      const { stderr, code } = await run('--version');
      expect(code).toBe(0);
      expect(stderr).toMatch(/s402-mcp v\d+\.\d+\.\d+/);
    });

    it('should show version with -v', async () => {
      const { stderr, code } = await run('-v');
      expect(code).toBe(0);
      expect(stderr).toMatch(/s402-mcp v\d+\.\d+\.\d+/);
    });
  });

  describe('auth', () => {
    it('should show auth status (no config)', async () => {
      const { stderr, code } = await run('auth', 'status');
      // May show "no configuration" or actual status — both are valid
      expect(code).toBe(0);
      expect(stderr).toContain('s402-mcp');
    });

    it('should reject unknown auth actions', async () => {
      const { stderr, code } = await run('auth', 'banana');
      expect(code).toBe(1);
      expect(stderr).toContain('Unknown auth action');
    });

    it('should stub auth refresh as coming soon', async () => {
      const { stderr, code } = await run('auth', 'refresh');
      expect(code).toBe(1);
      expect(stderr).toContain('coming soon');
    });
  });

  describe('unknown commands', () => {
    it('should reject unknown subcommands', async () => {
      const { stderr, code } = await run('banana');
      expect(code).toBe(1);
      expect(stderr).toContain('Unknown command');
      expect(stderr).toContain('banana');
    });
  });

  describe('stdout safety', () => {
    it('help should not write to stdout (stdout reserved for MCP)', async () => {
      const { stdout } = await run('help');
      expect(stdout).toBe('');
    });

    it('version should not write to stdout', async () => {
      const { stdout } = await run('version');
      expect(stdout).toBe('');
    });

    it('auth status should not write to stdout', async () => {
      const { stdout } = await run('auth', 'status');
      expect(stdout).toBe('');
    });
  });

  describe('server mode', () => {
    it('should fail without S402_PRIVATE_KEY when no subcommand given', async () => {
      const { stderr, code } = await exec('node', [BIN], {
        timeout: 5_000,
        env: { ...process.env, S402_PRIVATE_KEY: '', NODE_NO_WARNINGS: '1' },
      }).catch((err: { stderr?: string; code?: number }) => ({
        stdout: '',
        stderr: err.stderr ?? '',
        code: err.code ?? 1,
      }));
      expect(code).not.toBe(0);
      expect(stderr).toContain('S402_PRIVATE_KEY');
    });
  });
});
