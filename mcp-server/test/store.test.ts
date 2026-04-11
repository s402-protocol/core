/**
 * Store module tests
 *
 * Tests for ~/.s402/ credential and config storage.
 * Uses a temporary directory to avoid polluting the real ~/.s402/.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock homedir() to use a temp directory
const TEST_HOME = join(tmpdir(), `s402-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => TEST_HOME };
});

// Import AFTER mock is set up
const { saveConfig, loadStoredConfig, saveCredentials, loadCredentials, saveSession, loadSession, configExists, credentialsExist, S402_DIR } = await import('../src/store.js');

describe('store', () => {
  beforeEach(() => {
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe('S402_DIR', () => {
    it('should be rooted in homedir', () => {
      expect(S402_DIR).toBe(join(TEST_HOME, '.s402'));
    });
  });

  describe('saveConfig / loadStoredConfig', () => {
    it('should round-trip config', () => {
      const config = {
        version: 1 as const,
        network: 'sui:testnet',
        address: '0x' + 'a'.repeat(64),
        walletMethod: 'traditional' as const,
        maxPayment: '10000000',
        sessionBudget: '100000000',
        createdAt: '2026-04-04T00:00:00.000Z',
      };

      saveConfig(config);
      const loaded = loadStoredConfig();
      expect(loaded).toEqual(config);
    });

    it('should create ~/.s402/ directory if it does not exist', () => {
      expect(existsSync(S402_DIR)).toBe(false);

      saveConfig({
        version: 1,
        network: 'sui:testnet',
        address: '0xabc',
        walletMethod: 'traditional',
        maxPayment: '10000000',
        sessionBudget: '100000000',
        createdAt: new Date().toISOString(),
      });

      expect(existsSync(S402_DIR)).toBe(true);
    });

    it('should return null if no config exists', () => {
      expect(loadStoredConfig()).toBeNull();
    });

    it('should return null if config file is corrupt', () => {
      mkdirSync(S402_DIR, { recursive: true });
      const configPath = join(S402_DIR, 'config.json');
      writeFileSync(configPath, 'not-json', 'utf-8');
      expect(loadStoredConfig()).toBeNull();
    });

    it('should overwrite existing config', () => {
      const config1 = {
        version: 1 as const,
        network: 'sui:testnet',
        address: '0xfirst',
        walletMethod: 'traditional' as const,
        maxPayment: '1000000',
        sessionBudget: '10000000',
        createdAt: new Date().toISOString(),
      };
      const config2 = { ...config1, address: '0xsecond', network: 'sui:mainnet' };

      saveConfig(config1);
      saveConfig(config2);

      const loaded = loadStoredConfig();
      expect(loaded?.address).toBe('0xsecond');
      expect(loaded?.network).toBe('sui:mainnet');
    });
  });

  describe('saveCredentials / loadCredentials', () => {
    it('should round-trip credentials', () => {
      const key = 'suiprivkey1qztest123456789';
      saveCredentials(key);
      expect(loadCredentials()).toBe(key);
    });

    it('should set 0o600 permissions on credentials file', () => {
      saveCredentials('suiprivkey1qztest');
      const credPath = join(S402_DIR, 'credentials');
      const stat = statSync(credPath);
      // 0o600 = owner read/write only (decimal 384, but check mode bits)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('should return null if no credentials exist', () => {
      expect(loadCredentials()).toBeNull();
    });

    it('should trim whitespace from loaded credentials', () => {
      saveCredentials('suiprivkey1qztest');
      // saveCredentials appends \n — loadCredentials should trim it
      expect(loadCredentials()).toBe('suiprivkey1qztest');
    });
  });

  describe('saveSession / loadSession', () => {
    it('should round-trip session data', () => {
      const session = {
        version: 1 as const,
        method: 'zklogin' as const,
        address: '0x' + 'b'.repeat(64),
        network: 'sui:testnet',
        ephemeralKeyBase64: 'dGVzdGtleQ==',
        proof: { proofPoints: { a: [], b: [], c: [] } },
        salt: '12345',
        maxEpoch: 1000,
        randomness: 'abc123',
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        createdAt: new Date().toISOString(),
      };

      saveSession(session);
      const loaded = loadSession();
      expect(loaded).toEqual(session);
    });

    it('should set 0o600 permissions on session file', () => {
      saveSession({
        version: 1,
        method: 'zklogin',
        address: '0xtest',
        network: 'sui:testnet',
        ephemeralKeyBase64: 'key',
        proof: {},
        salt: '1',
        maxEpoch: 100,
        randomness: 'r',
        expiresAt: 0,
        createdAt: new Date().toISOString(),
      });

      const sessionPath = join(S402_DIR, 'session.json');
      const stat = statSync(sessionPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('should return null if no session exists', () => {
      expect(loadSession()).toBeNull();
    });
  });

  describe('configExists / credentialsExist', () => {
    it('should return false when nothing exists', () => {
      expect(configExists()).toBe(false);
      expect(credentialsExist()).toBe(false);
    });

    it('should return true after saving', () => {
      saveConfig({
        version: 1,
        network: 'sui:testnet',
        address: '0xtest',
        walletMethod: 'traditional',
        maxPayment: '10000000',
        sessionBudget: '100000000',
        createdAt: new Date().toISOString(),
      });
      saveCredentials('suiprivkey1qztest');

      expect(configExists()).toBe(true);
      expect(credentialsExist()).toBe(true);
    });
  });

  describe('directory permissions', () => {
    it('should create ~/.s402/ with 0o700 permissions', () => {
      saveConfig({
        version: 1,
        network: 'sui:testnet',
        address: '0xtest',
        walletMethod: 'traditional',
        maxPayment: '10000000',
        sessionBudget: '100000000',
        createdAt: new Date().toISOString(),
      });

      const stat = statSync(S402_DIR);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });
});
