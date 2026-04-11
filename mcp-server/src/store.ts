/**
 * s402 MCP — Credential & Config Store
 *
 * Stores configuration and credentials at ~/.s402/
 *
 * Files:
 *   ~/.s402/config.json    — Non-secret settings (network, limits, wallet method)
 *   ~/.s402/credentials    — Private key (traditional keypair path). File perms 0o600.
 *   ~/.s402/session.json   — zkLogin session data (ephemeral key, proof, expiry)
 *
 * Security:
 *   - credentials file is 0o600 (owner read/write only)
 *   - Directory is 0o700 (owner only)
 *   - Never write secrets to config.json (it's human-readable)
 *   - zkLogin ephemeral keys have bounded blast radius (~30 day expiry)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const S402_DIR = join(homedir(), '.s402');
const CONFIG_PATH = join(S402_DIR, 'config.json');
const CREDENTIALS_PATH = join(S402_DIR, 'credentials');
const SESSION_PATH = join(S402_DIR, 'session.json');

export interface S402StoredConfig {
  version: 1;
  network: string;
  address: string;
  walletMethod: 'traditional' | 'zklogin' | 'imported';
  maxPayment: string;
  sessionBudget: string;
  createdAt: string;
}

export interface S402Session {
  version: 1;
  method: 'zklogin';
  address: string;
  network: string;
  ephemeralKeyBase64: string;
  proof: unknown;
  salt: string;
  maxEpoch: number;
  randomness: string;
  expiresAt: number;
  createdAt: string;
}

function ensureDir(): void {
  if (!existsSync(S402_DIR)) {
    mkdirSync(S402_DIR, { mode: 0o700, recursive: true });
  }
}

export function saveConfig(config: S402StoredConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function loadStoredConfig(): S402StoredConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as S402StoredConfig;
  } catch {
    return null;
  }
}

export function saveCredentials(privateKey: string): void {
  ensureDir();
  writeFileSync(CREDENTIALS_PATH, privateKey + '\n', { encoding: 'utf-8', mode: 0o600 });
  // Double-ensure permissions (some platforms don't honor mode in writeFileSync)
  chmodSync(CREDENTIALS_PATH, 0o600);
}

export function loadCredentials(): string | null {
  try {
    return readFileSync(CREDENTIALS_PATH, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function saveSession(session: S402Session): void {
  ensureDir();
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  chmodSync(SESSION_PATH, 0o600);
}

export function loadSession(): S402Session | null {
  try {
    const raw = readFileSync(SESSION_PATH, 'utf-8');
    return JSON.parse(raw) as S402Session;
  } catch {
    return null;
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function credentialsExist(): boolean {
  return existsSync(CREDENTIALS_PATH);
}
