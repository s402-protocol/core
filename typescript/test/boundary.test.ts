/**
 * Architectural Boundary Test — S7 Chain-Agnostic Invariant
 *
 * This test greps s402's src/ directory for chain-specific patterns.
 * If any match is found, the test fails. This prevents AI sessions
 * (or humans) from accidentally introducing Sui/Solana/Ethereum-specific
 * validation into the chain-agnostic protocol layer.
 *
 * Chain-specific validation belongs in @sweefi/sui, @sweefi/solana, etc.
 *
 * See AGENTS.md → S7 invariant for the full rationale.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ── Helpers ──────────────────────────────────────────

const SRC_DIR = join(import.meta.dirname, '..', 'src');

/** Recursively collect all .ts files under a directory */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Strip single-line comments and block comments from source */
function stripComments(source: string): string {
  // Remove block comments (/* ... */) including JSDoc
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove single-line comments (// ...)
  stripped = stripped.replace(/\/\/.*/g, '');
  return stripped;
}

// ── Forbidden patterns ───────────────────────────────

interface ForbiddenPattern {
  /** Human-readable name */
  name: string;
  /** Regex to match in executable code (comments stripped) */
  pattern: RegExp;
  /** Why this is forbidden */
  reason: string;
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  // Sui-specific
  {
    name: 'Sui address regex',
    pattern: /0x\[0-9a-fA-F\]\{64\}/,
    reason: 'Sui address format validation belongs in @sweefi/sui',
  },
  {
    name: 'Sui address regex (alt)',
    pattern: /0x\[a-fA-F0-9\]\{64\}/,
    reason: 'Sui address format validation belongs in @sweefi/sui',
  },
  {
    name: 'Sui SDK import',
    pattern: /@mysten\/sui/,
    reason: 'Sui SDK imports belong in @sweefi/sui, not in s402 protocol layer',
  },
  {
    name: 'Sui coin type literal',
    pattern: /0x2::sui::SUI/,
    reason: 'Sui coin type constants belong in @sweefi/sui',
  },
  {
    name: '32-byte Sui address string check',
    pattern: /32.byte.*[Ss]ui.*address|[Ss]ui.*address.*32.byte/,
    reason: 'Sui-specific address length checks belong in @sweefi/sui',
  },

  // Solana-specific
  {
    name: 'Solana SDK import',
    pattern: /@solana\/web3/,
    reason: 'Solana SDK imports belong in @sweefi/solana',
  },
  {
    name: 'Solana base58 validation',
    pattern: /base58|bs58/i,
    reason: 'Base58 encoding (Solana addresses) belongs in @sweefi/solana',
  },
  {
    name: 'Solana lamport reference',
    pattern: /lamport(?:s)?(?:\s|$|[^-])/i,
    reason: 'Lamport (Solana denomination) references belong in @sweefi/solana',
  },

  // Ethereum-specific
  {
    name: 'Ethers.js import',
    pattern: /from\s+['"]ethers['"]/,
    reason: 'Ethers.js imports are chain-specific',
  },
  {
    name: 'Viem import',
    pattern: /from\s+['"]viem['"]/,
    reason: 'Viem imports are chain-specific',
  },
  {
    name: 'EIP-55 mixed-case address regex',
    pattern: /0x\[0-9a-fA-F\]\{40\}/,
    reason: 'Ethereum address format validation is chain-specific',
  },
];

// ── Tests ────────────────────────────────────────────

describe('S7: Chain-agnostic boundary', () => {
  const srcFiles = collectTsFiles(SRC_DIR);

  it('should find TypeScript source files', () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  for (const forbidden of FORBIDDEN_PATTERNS) {
    it(`src/ must not contain: ${forbidden.name}`, () => {
      const violations: string[] = [];

      for (const file of srcFiles) {
        const raw = readFileSync(file, 'utf-8');
        const code = stripComments(raw);
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (forbidden.pattern.test(lines[i])) {
            const rel = relative(join(SRC_DIR, '..'), file);
            violations.push(`  ${rel}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }

      if (violations.length > 0) {
        expect.fail(
          `Chain-specific pattern "${forbidden.name}" found in s402 src/:\n` +
          `Reason: ${forbidden.reason}\n\n` +
          violations.join('\n') +
          '\n\nSee AGENTS.md → S7 invariant.'
        );
      }
    });
  }

  it('src/ must not import any chain-specific npm packages', () => {
    const chainPackages = [
      '@mysten/sui',
      '@mysten/seal',
      '@solana/web3.js',
      '@solana/spl-token',
      'ethers',
      'viem',
      'web3',
    ];

    const violations: string[] = [];

    for (const file of srcFiles) {
      const source = readFileSync(file, 'utf-8');
      // Match import/require statements (not comments)
      const code = stripComments(source);

      for (const pkg of chainPackages) {
        const importRegex = new RegExp(`(?:import|require).*['"]${pkg.replace('/', '\\/')}`, 'g');
        const lines = code.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (importRegex.test(lines[i])) {
            const rel = relative(join(SRC_DIR, '..'), file);
            violations.push(`  ${rel}:${i + 1}: imports "${pkg}"`);
          }
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        'Chain-specific package imports found in s402 src/:\n\n' +
        violations.join('\n') +
        '\n\nThese belong in @sweefi/sui or @sweefi/solana, not in s402.'
      );
    }
  });
});
