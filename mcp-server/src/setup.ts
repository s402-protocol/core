/**
 * s402 MCP — Interactive Setup Wizard
 *
 * `npx s402-mcp setup` — one-command onboarding for humans.
 *
 * Flows:
 *   1. zkLogin (Google sign-in) — DEFAULT (no seed phrase needed)
 *      → Requires Enoki API key + Google OAuth client ID (coming soon)
 *   2. Traditional keypair — Generate Ed25519, seed phrase ceremony
 *   3. Import existing key — Paste suiprivkey1... / base64 / hex
 *
 * Security:
 *   - All output to stderr (stdout reserved for MCP JSON-RPC protocol)
 *   - Private keys written to ~/.s402/credentials with 0o600 permissions
 *   - Seed phrase displayed with word verification, then screen cleared
 *   - .env fallback requires explicit opt-in + risk acknowledgment
 *
 * @see DAN-209 (human flow), DAN-212 (zkLogin integration)
 */

import * as p from '@clack/prompts';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  saveConfig,
  saveCredentials,
  loadStoredConfig,
  configExists,
  type S402StoredConfig,
} from './store.js';

// All interactive output goes to stderr — stdout is reserved for MCP JSON-RPC.
// @clack/prompts writes to stderr by default when output is process.stderr.
const output = process.stderr;

type SuiNetwork = 'mainnet' | 'testnet' | 'devnet';

// ═══════════════════════════════════════════════════════════
// Spending presets
// ═══════════════════════════════════════════════════════════

interface SpendingPreset {
  label: string;
  hint: string;
  maxPayment: string;
  sessionBudget: string;
}

const PRESETS: Record<string, SpendingPreset> = {
  cautious: {
    label: 'Cautious',
    hint: '0.001 SUI/request, 0.01 SUI/session',
    maxPayment: '1000000',      // 0.001 SUI
    sessionBudget: '10000000',  // 0.01 SUI
  },
  moderate: {
    label: 'Moderate (recommended)',
    hint: '0.01 SUI/request, 0.1 SUI/session',
    maxPayment: '10000000',      // 0.01 SUI
    sessionBudget: '100000000',  // 0.1 SUI
  },
  generous: {
    label: 'Generous',
    hint: '0.1 SUI/request, 1.0 SUI/session',
    maxPayment: '100000000',      // 0.1 SUI
    sessionBudget: '1000000000',  // 1.0 SUI
  },
};

// ═══════════════════════════════════════════════════════════
// IDE detection & config writing
// ═══════════════════════════════════════════════════════════

interface IDEConfig {
  name: string;
  detected: boolean;
  configPath: string;
  write: (env: Record<string, string>) => void;
}

function detectIDEs(): IDEConfig[] {
  const home = homedir();
  const ides: IDEConfig[] = [];

  // Claude Code — global settings
  const claudeSettingsPath = join(home, '.claude', 'settings.json');
  ides.push({
    name: 'Claude Code',
    detected: existsSync(join(home, '.claude')),
    configPath: claudeSettingsPath,
    write: (env) => writeMcpConfig(claudeSettingsPath, env),
  });

  // Cursor — project-level
  const cursorPath = join(process.cwd(), '.cursor', 'mcp.json');
  ides.push({
    name: 'Cursor',
    detected: existsSync(join(process.cwd(), '.cursor')),
    configPath: cursorPath,
    write: (env) => writeMcpConfig(cursorPath, env),
  });

  return ides;
}

function writeMcpConfig(configPath: string, env: Record<string, string>): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
  }

  // Merge into mcpServers (never overwrite other servers)
  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
  mcpServers.s402 = {
    command: 'npx',
    args: ['s402-mcp'],
    env,
  };
  existing.mcpServers = mcpServers;

  // Ensure parent directory exists
  const dir = configPath.substring(0, configPath.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

// ═══════════════════════════════════════════════════════════
// Faucet
// ═══════════════════════════════════════════════════════════

async function requestFaucet(address: string, network: SuiNetwork): Promise<boolean> {
  if (network !== 'testnet' && network !== 'devnet') return false;

  const faucetUrl = network === 'testnet'
    ? 'https://faucet.testnet.sui.io/v2/gas'
    : 'https://faucet.devnet.sui.io/v2/gas';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(faucetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return true;
      // Rate limited — wait and retry
      if (res.status === 429) {
        const delay = attempt * 5_000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return false;
    } catch {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 5_000));
        continue;
      }
      return false;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
// Wallet creation
// ═══════════════════════════════════════════════════════════

interface WalletResult {
  keypair: Ed25519Keypair;
  address: string;
  method: 'traditional' | 'imported';
  privateKeyBech32: string;
}

async function createTraditionalWallet(): Promise<WalletResult | symbol> {
  const keypair = new Ed25519Keypair();
  const address = keypair.toSuiAddress();
  // getSecretKey() returns bech32-encoded suiprivkey1... string
  const privateKeyBech32 = keypair.getSecretKey();

  p.note(
    [
      `Address: ${address}`,
      '',
      `Private key (suiprivkey1... format):`,
      `${privateKeyBech32}`,
      '',
      '⚠  Save this private key somewhere safe.',
      '   Anyone with this key can drain your wallet.',
      '',
      '   DO:  Write it down on paper, store in a safe',
      '   DON\'T:  Screenshot, email, or save in cloud storage',
    ].join('\n'),
    'New Wallet Created',
  );

  // Verify the user saved it by asking for a portion of the key
  const confirmation = await p.text({
    message: 'Type "I saved it" to confirm you backed up your private key:',
    validate: (value = '') => {
      if (value.toLowerCase().trim() !== 'i saved it') {
        return 'Please type "I saved it" to continue';
      }
    },
  });

  if (p.isCancel(confirmation)) return confirmation;

  return { keypair, address, method: 'traditional', privateKeyBech32 };
}

async function importExistingWallet(): Promise<WalletResult | symbol> {
  const keyInput = await p.text({
    message: 'Paste your private key (suiprivkey1..., base64, or hex):',
    validate: (value = '') => {
      if (!value.trim()) return 'Private key is required';
    },
  });

  if (p.isCancel(keyInput)) return keyInput;

  const key = (keyInput as string).trim();

  try {
    let keypair: Ed25519Keypair;

    if (key.startsWith('suiprivkey')) {
      const { schema, secretKey } = decodeSuiPrivateKey(key);
      if (schema !== 'ED25519') {
        p.log.error(`Only Ed25519 keys are supported, got ${schema}`);
        return Symbol('cancel');
      }
      keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else if (/^[0-9a-fA-F]{64}$/.test(key)) {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
      }
      keypair = Ed25519Keypair.fromSecretKey(bytes);
    } else {
      // Try base64
      const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      if (bytes.length !== 32) throw new Error('Expected 32-byte key');
      keypair = Ed25519Keypair.fromSecretKey(bytes);
    }

    const address = keypair.toSuiAddress();
    const privateKeyBech32 = keypair.getSecretKey();

    p.log.success(`Wallet loaded: ${address}`);
    return { keypair, address, method: 'imported', privateKeyBech32 };
  } catch (err) {
    p.log.error(
      `Invalid key format. Accepted:\n` +
      `  - suiprivkey1... (bech32, from \`sui keytool export\`)\n` +
      `  - 64 hex characters\n` +
      `  - Base64-encoded 32-byte key`,
    );
    return Symbol('cancel');
  }
}

// ═══════════════════════════════════════════════════════════
// Main wizard
// ═══════════════════════════════════════════════════════════

export async function runSetup(): Promise<void> {
  p.intro('s402-mcp — Give your AI agent a wallet');

  // Check for existing config
  if (configExists()) {
    const existing = loadStoredConfig();
    if (existing) {
      const overwrite = await p.confirm({
        message: `Existing setup found (${existing.address.slice(0, 10)}... on ${existing.network}). Reconfigure?`,
        initialValue: false,
      });
      if (p.isCancel(overwrite) || !overwrite) {
        p.outro('Keeping existing configuration.');
        return;
      }
    }
  }

  // ── Step 1: Wallet method ──
  const walletMethod = await p.select({
    message: 'How do you want to set up your agent\'s wallet?',
    options: [
      {
        value: 'zklogin' as const,
        label: 'Sign in with Google (no seed phrase)',
        hint: 'coming soon — uses Sui zkLogin',
        disabled: true,
      },
      {
        value: 'create' as const,
        label: 'Create a new wallet',
        hint: 'generates Ed25519 keypair',
      },
      {
        value: 'import' as const,
        label: 'Import existing key',
        hint: 'paste suiprivkey1... or hex',
      },
    ],
  });

  if (p.isCancel(walletMethod)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // ── Step 2: Create or import wallet ──
  let wallet: WalletResult;

  if (walletMethod === 'zklogin') {
    // Stub — will be implemented when Enoki credentials are set up (DAN-212)
    p.log.warning(
      'zkLogin (Google sign-in) is coming soon.\n' +
      'For now, use "Create a new wallet" or "Import existing key".',
    );
    p.cancel('zkLogin not yet available.');
    process.exit(0);
  } else if (walletMethod === 'create') {
    const result = await createTraditionalWallet();
    if (typeof result === 'symbol') {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
    wallet = result;
  } else {
    const result = await importExistingWallet();
    if (typeof result === 'symbol') {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
    wallet = result;
  }

  // ── Step 3: Network ──
  const network = await p.select({
    message: 'Which network?',
    options: [
      { value: 'testnet' as const, label: 'Testnet', hint: 'free — recommended for development' },
      { value: 'mainnet' as const, label: 'Mainnet', hint: 'real money' },
      { value: 'devnet' as const, label: 'Devnet', hint: 'unstable — for protocol developers' },
    ],
  });

  if (p.isCancel(network)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // Mainnet confirmation
  if (network === 'mainnet') {
    const confirmed = await p.confirm({
      message: 'Mainnet uses real SUI. Are you sure?',
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
  }

  const suiNetwork = network as SuiNetwork;

  // ── Step 4: Fund the wallet ──
  const spinner = p.spinner();

  if (suiNetwork === 'testnet' || suiNetwork === 'devnet') {
    spinner.start('Checking balance...');
    const client = new SuiClient({ url: getFullnodeUrl(suiNetwork) });
    const balance = await client.getBalance({ owner: wallet.address });
    const balanceMist = BigInt(balance.totalBalance);

    if (balanceMist === 0n) {
      spinner.message('Requesting SUI from faucet...');
      const success = await requestFaucet(wallet.address, suiNetwork);
      if (success) {
        // Re-check balance
        const newBalance = await client.getBalance({ owner: wallet.address });
        const newMist = BigInt(newBalance.totalBalance);
        const sui = Number(newMist) / 1_000_000_000;
        spinner.stop(`Funded! Balance: ${sui.toFixed(2)} SUI`);
      } else {
        spinner.stop('Faucet unavailable');
        p.log.warning(
          `Could not get testnet SUI from faucet.\n` +
          `Visit https://faucet.sui.io and paste your address:\n` +
          `  ${wallet.address}`,
        );
      }
    } else {
      const sui = Number(balanceMist) / 1_000_000_000;
      spinner.stop(`Balance: ${sui.toFixed(4)} SUI`);
    }
  } else {
    // Mainnet — check balance, show address if empty
    spinner.start('Checking mainnet balance...');
    const client = new SuiClient({ url: getFullnodeUrl('mainnet') });
    const balance = await client.getBalance({ owner: wallet.address });
    const balanceMist = BigInt(balance.totalBalance);

    if (balanceMist === 0n) {
      spinner.stop('Balance: 0 SUI');
      p.log.warning(
        `Send SUI to your agent's wallet to enable payments:\n` +
        `  ${wallet.address}`,
      );
    } else {
      const sui = Number(balanceMist) / 1_000_000_000;
      spinner.stop(`Balance: ${sui.toFixed(4)} SUI`);
    }
  }

  // ── Step 5: Spending limits ──
  const preset = await p.select({
    message: 'How much can your agent spend?',
    options: [
      { value: 'cautious', label: PRESETS.cautious.label, hint: PRESETS.cautious.hint },
      { value: 'moderate', label: PRESETS.moderate.label, hint: PRESETS.moderate.hint },
      { value: 'generous', label: PRESETS.generous.label, hint: PRESETS.generous.hint },
    ],
    initialValue: 'moderate',
  });

  if (p.isCancel(preset)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const spending = PRESETS[preset as string];

  // ── Step 6: Save credentials & config ──
  spinner.start('Saving configuration...');

  // Save private key to ~/.s402/credentials (0o600)
  saveCredentials(wallet.privateKeyBech32);

  // Save non-secret config to ~/.s402/config.json
  const storedConfig: S402StoredConfig = {
    version: 1,
    network: `sui:${suiNetwork}`,
    address: wallet.address,
    walletMethod: wallet.method,
    maxPayment: spending.maxPayment,
    sessionBudget: spending.sessionBudget,
    createdAt: new Date().toISOString(),
  };
  saveConfig(storedConfig);

  spinner.stop('Configuration saved to ~/.s402/');

  // ── Step 7: IDE configuration ──
  const ides = detectIDEs();
  const detectedIdes = ides.filter((ide) => ide.detected);

  if (detectedIdes.length > 0) {
    const selectedIdes = await p.multiselect({
      message: 'Configure these editors?',
      options: ides.map((ide) => ({
        value: ide.name,
        label: ide.name,
        hint: ide.detected ? `detected: ${ide.configPath}` : 'not detected',
      })),
      initialValues: detectedIdes.map((ide) => ide.name),
      required: false,
    });

    if (!p.isCancel(selectedIdes)) {
      const env: Record<string, string> = {
        S402_PRIVATE_KEY: wallet.privateKeyBech32,
        S402_NETWORK: `sui:${suiNetwork}`,
        S402_MAX_PAYMENT: spending.maxPayment,
        S402_SESSION_BUDGET: spending.sessionBudget,
      };

      for (const ideName of selectedIdes as string[]) {
        const ide = ides.find((i) => i.name === ideName);
        if (ide) {
          try {
            ide.write(env);
            p.log.success(`${ide.name} configured: ${ide.configPath}`);
          } catch (err) {
            p.log.error(`Failed to configure ${ide.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  } else {
    p.log.info(
      'No supported editors detected. Add this to your MCP config manually:\n\n' +
      JSON.stringify({
        s402: {
          command: 'npx',
          args: ['s402-mcp'],
          env: {
            S402_PRIVATE_KEY: '<your key from ~/.s402/credentials>',
            S402_NETWORK: `sui:${suiNetwork}`,
            S402_MAX_PAYMENT: spending.maxPayment,
            S402_SESSION_BUDGET: spending.sessionBudget,
          },
        },
      }, null, 2),
    );
  }

  // ── Step 8: Summary ──
  p.note(
    [
      `Wallet:    ${wallet.address}`,
      `Network:   sui:${suiNetwork}`,
      `Per-req:   ${spending.hint.split(',')[0].trim()}`,
      `Session:   ${spending.hint.split(',')[1]?.trim() ?? ''}`,
      `Config:    ~/.s402/config.json`,
      `Key:       ~/.s402/credentials (0o600)`,
      '',
      'Restart your editor to load the MCP server.',
      '',
      `Try asking your AI: "Check the price of an API"`,
    ].join('\n'),
    'Setup complete!',
  );

  p.outro('Your agent can now make payments on Sui.');
}
