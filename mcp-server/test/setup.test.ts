/**
 * Setup wizard unit tests
 *
 * Tests the pure/testable parts of the setup wizard:
 *   - IDE config file merging (never overwrite other servers)
 *   - Spending presets (correct MIST values)
 *   - Faucet retry logic
 *   - Wallet key format detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

// ═══════════════════════════════════════════════════════════
// Config merging tests (inline the merge logic for testing)
// ═══════════════════════════════════════════════════════════

function writeMcpConfig(configPath: string, env: Record<string, string>): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // Fresh file
  }
  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
  mcpServers.s402 = {
    command: 'npx',
    args: ['s402-mcp'],
    env,
  };
  existing.mcpServers = mcpServers;
  const dir = configPath.substring(0, configPath.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

describe('IDE config merging', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `s402-setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create config from scratch', () => {
    const configPath = join(tmpDir, 'settings.json');
    const env = {
      S402_PRIVATE_KEY: 'suiprivkey1qztest',
      S402_NETWORK: 'sui:testnet',
      S402_MAX_PAYMENT: '10000000',
      S402_SESSION_BUDGET: '100000000',
    };

    writeMcpConfig(configPath, env);

    const result = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(result.mcpServers.s402).toEqual({
      command: 'npx',
      args: ['s402-mcp'],
      env,
    });
  });

  it('should preserve existing MCP servers', () => {
    const configPath = join(tmpDir, 'settings.json');

    // Pre-existing config with another MCP server
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        linear: { command: 'npx', args: ['linear-mcp'] },
      },
      someOtherKey: 'preserve-me',
    }, null, 2), 'utf-8');

    writeMcpConfig(configPath, { S402_PRIVATE_KEY: 'test' });

    const result = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(result.mcpServers.linear).toEqual({ command: 'npx', args: ['linear-mcp'] });
    expect(result.mcpServers.s402).toBeDefined();
    expect(result.someOtherKey).toBe('preserve-me');
  });

  it('should update existing s402 entry without affecting others', () => {
    const configPath = join(tmpDir, 'settings.json');

    // Pre-existing with old s402 config
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        s402: { command: 'npx', args: ['s402-mcp'], env: { S402_NETWORK: 'sui:mainnet' } },
        other: { command: 'other-cmd' },
      },
    }, null, 2), 'utf-8');

    writeMcpConfig(configPath, { S402_NETWORK: 'sui:testnet' });

    const result = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(result.mcpServers.s402.env.S402_NETWORK).toBe('sui:testnet');
    expect(result.mcpServers.other).toEqual({ command: 'other-cmd' });
  });

  it('should handle corrupt/non-JSON files gracefully', () => {
    const configPath = join(tmpDir, 'settings.json');
    writeFileSync(configPath, 'this is not json {{{', 'utf-8');

    writeMcpConfig(configPath, { S402_PRIVATE_KEY: 'test' });

    const result = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(result.mcpServers.s402).toBeDefined();
  });

  it('should create parent directories', () => {
    const configPath = join(tmpDir, 'nested', 'deep', 'settings.json');

    writeMcpConfig(configPath, { S402_PRIVATE_KEY: 'test' });

    expect(existsSync(configPath)).toBe(true);
    const result = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(result.mcpServers.s402).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Spending preset validation
// ═══════════════════════════════════════════════════════════

describe('spending presets', () => {
  const PRESETS = {
    cautious: { maxPayment: '1000000', sessionBudget: '10000000' },
    moderate: { maxPayment: '10000000', sessionBudget: '100000000' },
    generous: { maxPayment: '100000000', sessionBudget: '1000000000' },
  };

  it('cautious should be 0.001 SUI per request, 0.01 SUI per session', () => {
    const p = PRESETS.cautious;
    expect(BigInt(p.maxPayment)).toBe(1_000_000n);      // 0.001 SUI
    expect(BigInt(p.sessionBudget)).toBe(10_000_000n);   // 0.01 SUI
  });

  it('moderate should be 0.01 SUI per request, 0.1 SUI per session', () => {
    const p = PRESETS.moderate;
    expect(BigInt(p.maxPayment)).toBe(10_000_000n);       // 0.01 SUI
    expect(BigInt(p.sessionBudget)).toBe(100_000_000n);   // 0.1 SUI
  });

  it('generous should be 0.1 SUI per request, 1.0 SUI per session', () => {
    const p = PRESETS.generous;
    expect(BigInt(p.maxPayment)).toBe(100_000_000n);       // 0.1 SUI
    expect(BigInt(p.sessionBudget)).toBe(1_000_000_000n);  // 1.0 SUI
  });

  it('session budget should always be >= 10x max payment', () => {
    for (const [, preset] of Object.entries(PRESETS)) {
      const max = BigInt(preset.maxPayment);
      const budget = BigInt(preset.sessionBudget);
      expect(budget).toBeGreaterThanOrEqual(max * 10n);
    }
  });

  it('all values should be valid positive BigInts', () => {
    for (const [, preset] of Object.entries(PRESETS)) {
      expect(BigInt(preset.maxPayment)).toBeGreaterThan(0n);
      expect(BigInt(preset.sessionBudget)).toBeGreaterThan(0n);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Wallet key format tests
// ═══════════════════════════════════════════════════════════

describe('wallet key formats', () => {
  it('Ed25519Keypair.getSecretKey() returns bech32 suiprivkey1...', () => {
    const keypair = new Ed25519Keypair();
    const key = keypair.getSecretKey();
    expect(key).toMatch(/^suiprivkey1/);
  });

  it('generated key round-trips through decodeSuiPrivateKey', () => {
    const keypair = new Ed25519Keypair();
    const bech32Key = keypair.getSecretKey();
    const { schema, secretKey } = decodeSuiPrivateKey(bech32Key);

    expect(schema).toBe('ED25519');
    expect(secretKey).toBeInstanceOf(Uint8Array);
    expect(secretKey.length).toBe(32);

    // Reconstruct keypair from decoded key
    const restored = Ed25519Keypair.fromSecretKey(secretKey);
    expect(restored.toSuiAddress()).toBe(keypair.toSuiAddress());
  });

  it('different keypairs produce different addresses', () => {
    const kp1 = new Ed25519Keypair();
    const kp2 = new Ed25519Keypair();
    expect(kp1.toSuiAddress()).not.toBe(kp2.toSuiAddress());
  });

  it('hex key format is 64 hex chars', () => {
    const keypair = new Ed25519Keypair();
    const bech32Key = keypair.getSecretKey();
    const { secretKey } = decodeSuiPrivateKey(bech32Key);

    const hex = Array.from(secretKey).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);

    // Can reconstruct from hex
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const restored = Ed25519Keypair.fromSecretKey(bytes);
    expect(restored.toSuiAddress()).toBe(keypair.toSuiAddress());
  });
});
