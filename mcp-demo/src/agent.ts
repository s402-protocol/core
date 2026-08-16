import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

import { s402PaymentObject, DEMO_PROVIDER_ADDRESS } from './protocols/s402.js';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000';
const REAL_SETTLEMENT = process.env.SUI_REAL_SETTLEMENT === '1';
const MNEMONIC = process.env.SUI_TESTNET_MNEMONIC;
const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443';

// gRPC, not JSON-RPC: Sui deprecated JSON-RPC on public fullnodes and every core
// method now answers -32601. Note the URL is unchanged — gRPC is served from the
// same host and port, so this is a client swap and not an endpoint move.
const sui = new SuiGrpcClient({ network: 'testnet', baseUrl: SUI_RPC });

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
  // The gRPC client has no signAndExecuteTransaction, so the sender is no longer
  // implied by a signer argument and must be set explicitly before the build.
  tx.setSender(keypair.toSuiAddress());
  const [coin] = tx.splitCoins(tx.gas, [s402PaymentObject.amount]);
  tx.transferObjects([coin], DEMO_PROVIDER_ADDRESS);

  const bytes = await tx.build({ client: sui });
  const { signature } = await keypair.signTransaction(bytes);

  const result = await sui.core.executeTransaction({
    transaction: bytes,
    signatures: [signature]
  });

  // TransactionResult is a union discriminated on $kind; the failure arm carries
  // the transaction under a different key, so narrow rather than reach for .Transaction.
  if (result.$kind !== 'Transaction') {
    throw new Error(`Settlement did not execute: ${result.FailedTransaction.digest}`);
  }

  console.log(`  Sui testnet tx: ${result.Transaction.digest}`);
  return result.Transaction.digest;
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
