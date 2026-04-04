/**
 * s402 MCP Server Configuration
 *
 * Loads configuration from environment variables:
 *   S402_PRIVATE_KEY     — Sui Ed25519 private key (suiprivkey1..., base64, or hex)
 *   S402_NETWORK         — Network identifier (default: sui:mainnet)
 *   S402_MAX_PAYMENT     — Safety cap per request in MIST (default: 10_000_000 = 0.01 SUI)
 *   S402_SESSION_BUDGET  — Cumulative session spending cap in MIST (default: 100_000_000 = 0.1 SUI)
 *   S402_TIMEOUT_MS      — Fetch timeout in milliseconds (default: 30000)
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';

export interface S402Config {
  keypair: Ed25519Keypair;
  address: string;
  network: string;
  suiNetwork: 'mainnet' | 'testnet' | 'devnet';
  maxPayment: bigint;
  sessionBudget: bigint;
  timeoutMs: number;
  client: SuiClient;
}

type SuiNetwork = 'mainnet' | 'testnet' | 'devnet';

/** The SUI native coin type — used for asset validation */
export const SUI_COIN_TYPE = '0x2::sui::SUI';

/** Maximum response body size (10 MB) */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function parseSuiNetwork(network: string): SuiNetwork {
  const net = network.includes(':') ? network.split(':')[1] : network;
  if (net === 'mainnet' || net === 'testnet' || net === 'devnet') return net;
  throw new Error(
    `Unsupported network: "${network}". Use sui:mainnet, sui:testnet, or sui:devnet`,
  );
}

function loadKeypair(key: string): Ed25519Keypair {
  // Format 1: Bech32 suiprivkey1... (from `sui keytool export`)
  if (key.startsWith('suiprivkey')) {
    const { schema, secretKey } = decodeSuiPrivateKey(key);
    if (schema !== 'ED25519') {
      throw new Error(`Only Ed25519 keys are supported, got ${schema}`);
    }
    return Ed25519Keypair.fromSecretKey(secretKey);
  }

  // Format 2: Base64-encoded 32-byte secret key
  try {
    const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    if (bytes.length === 32) return Ed25519Keypair.fromSecretKey(bytes);
  } catch {
    // Not valid base64, try hex
  }

  // Format 3: Hex-encoded 32-byte secret key (64 hex chars)
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
    }
    return Ed25519Keypair.fromSecretKey(bytes);
  }

  throw new Error(
    'Invalid S402_PRIVATE_KEY. Accepted formats:\n' +
      '  - suiprivkey1... (bech32, from `sui keytool export`)\n' +
      '  - Base64-encoded 32-byte secret key\n' +
      '  - Hex-encoded 32-byte secret key (64 hex chars)',
  );
}

function parsePositiveBigInt(value: string, name: string): bigint {
  const n = BigInt(value);
  if (n <= 0n) throw new Error(`${name} must be a positive integer, got ${value}`);
  return n;
}

export function loadConfig(): S402Config {
  const privateKey = process.env.S402_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'S402_PRIVATE_KEY is required.\n' +
        'Set it to your Sui Ed25519 private key (suiprivkey1..., base64, or hex).\n' +
        'Generate one: sui keytool generate ed25519',
    );
  }

  const keypair = loadKeypair(privateKey.trim());
  const address = keypair.toSuiAddress();
  const network = process.env.S402_NETWORK || 'sui:mainnet';
  const suiNetwork = parseSuiNetwork(network);

  const maxPayment = parsePositiveBigInt(
    process.env.S402_MAX_PAYMENT || '10000000',
    'S402_MAX_PAYMENT',
  ); // 0.01 SUI default

  const sessionBudget = parsePositiveBigInt(
    process.env.S402_SESSION_BUDGET || '100000000',
    'S402_SESSION_BUDGET',
  ); // 0.1 SUI default

  const timeoutMs = parseInt(process.env.S402_TIMEOUT_MS || '30000', 10);
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    throw new Error('S402_TIMEOUT_MS must be a positive integer');
  }

  const client = new SuiClient({ url: getFullnodeUrl(suiNetwork) });

  return { keypair, address, network, suiNetwork, maxPayment, sessionBudget, timeoutMs, client };
}

/** Convert MIST (smallest unit) to human-readable SUI */
export function mistToSui(mist: string | bigint): string {
  const value = typeof mist === 'string' ? BigInt(mist) : mist;
  const whole = value / 1_000_000_000n;
  const frac = value % 1_000_000_000n;
  if (frac === 0n) return `${whole} SUI`;
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fracStr} SUI`;
}
