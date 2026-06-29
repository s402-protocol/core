import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

import { s402PaymentObject, DEMO_PROVIDER_ADDRESS } from './protocols/s402.js';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000';
const REAL_SETTLEMENT = process.env.SUI_REAL_SETTLEMENT === '1';
const MNEMONIC = process.env.SUI_TESTNET_MNEMONIC;

const sui = new SuiClient({ url: getFullnodeUrl('testnet') });

async function rpc<T>(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(SERVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json() as Promise<T>;
}

async function settleViaS402(): Promise<string> {
  if (!REAL_SETTLEMENT) {
    console.log('  (envelope-only mode — skipping real Sui transfer)');
    return '0xdemo_digest_placeholder';
  }
  if (!MNEMONIC) throw new Error('SUI_TESTNET_MNEMONIC env var required for real settlement');

  const keypair = Ed25519Keypair.deriveKeypair(MNEMONIC);
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [s402PaymentObject.amount]);
  tx.transferObjects([coin], DEMO_PROVIDER_ADDRESS);

  const result = await sui.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true }
  });

  console.log(`  Sui testnet tx: ${result.digest}`);
  return result.digest;
}

async function main() {
  console.log('1. Calling tools/list');
  const list = await rpc<{ result: { tools: Array<{ name: string; payment: unknown[] }> } }>('tools/list');
  const tool = list.result.tools[0];
  console.log(`   Server advertises ${tool.payment.length} payment protocols:`, tool.payment.map((p: any) => p.protocol).join(', '));

  console.log('\n2. Calling tools/call without payment');
  const challenge = await rpc<{ error?: { code: number; data: { payment: unknown[] } } }>('tools/call', {
    name: 'summarize',
    arguments: { text: 'The protocol is the platform.' }
  });
  if (challenge.error?.code === -32402) {
    console.log(`   Got -32402 Payment Required with ${challenge.error.data.payment.length} options`);
  }

  console.log('\n3. Choosing s402 protocol, settling on Sui');
  const digest = await settleViaS402();

  console.log('\n4. Retrying tools/call with payment proof');
  const final = await rpc<{ result: { content: Array<{ text: string }> } }>(
    'tools/call',
    { name: 'summarize', arguments: { text: 'The protocol is the platform. Wire formats commoditize. Substrates compound.' } },
    { 'x-payment-protocol': 's402', 'x-s402-tx-digest': digest }
  );
  console.log(`   Tool result: ${final.result.content[0].text}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
