import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { summarizeTool, summarize } from './tools/summarize.js';
import { s402PaymentObject, DEMO_PROVIDER_ADDRESS } from './protocols/s402.js';
import { x402PaymentObject } from './protocols/x402.js';
import { stripeMppPaymentObject } from './protocols/stripe-mpp.js';

const PORT = Number(process.env.PORT ?? 3000);
const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443';
const REAL_SETTLEMENT = process.env.SUI_REAL_SETTLEMENT === '1';

// gRPC, not JSON-RPC: Sui deprecated JSON-RPC on public fullnodes. SUI_RPC is
// unchanged — gRPC is served from the same host and port.
const sui = new SuiGrpcClient({ network: 'testnet', baseUrl: SUI_RPC });

// The public endpoint is load-balanced, so the verifying read can land on a node
// that has not yet caught up to the transaction the agent just executed. Observed:
// the first read returns NOT_FOUND and the second, ~4s later, succeeds — for a
// transaction whose own execute call already reported success. Without this retry
// the demo intermittently rejects payments that actually settled, and it does so
// more often on a fast machine.
const SETTLEMENT_READ_ATTEMPTS = 6;
const SETTLEMENT_READ_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNotFound = (err: unknown): boolean => {
  const code = (err as { code?: unknown })?.code;
  if (code === 'NOT_FOUND') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /not[ %]?found/i.test(message);
};

const paymentRequired = (id: number | string) => ({
  jsonrpc: '2.0' as const,
  id,
  error: {
    code: -32402,
    message: 'Payment Required',
    data: {
      tool: summarizeTool.name,
      payment: [x402PaymentObject, s402PaymentObject, stripeMppPaymentObject]
    }
  }
});

async function verifyS402Settlement(txDigest: string): Promise<boolean> {
  if (!REAL_SETTLEMENT) return true;

  for (let attempt = 1; attempt <= SETTLEMENT_READ_ATTEMPTS; attempt++) {
    try {
      // balanceChanges is empty unless it is requested. Omitting `include` returns
      // the field present and undefined, which would make the credit check below
      // fail closed on every real payment.
      const result = await sui.core.getTransaction({
        digest: txDigest,
        include: { effects: true, balanceChanges: true }
      });

      if (result.$kind !== 'Transaction') return false;
      const tx = result.Transaction;
      if (!tx.effects.status.success) return false;

      // gRPC balance changes are flat — { coinType, address, amount } — where
      // JSON-RPC nested the recipient under owner.AddressOwner.
      return tx.balanceChanges.some(
        (change) =>
          change.address === DEMO_PROVIDER_ADDRESS &&
          BigInt(change.amount) >= BigInt(s402PaymentObject.amount)
      );
    } catch (err) {
      if (!isNotFound(err) || attempt === SETTLEMENT_READ_ATTEMPTS) return false;
      await sleep(SETTLEMENT_READ_DELAY_MS);
    }
  }

  return false;
}

const app = new Hono();

app.post('/', async (c) => {
  const body = await c.req.json<{
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
  }>();

  if (body.method === 'tools/list') {
    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: [{
          ...summarizeTool,
          payment: [x402PaymentObject, s402PaymentObject, stripeMppPaymentObject]
        }]
      }
    });
  }

  if (body.method === 'tools/call') {
    const protocol = c.req.header('x-payment-protocol');
    const txDigest = c.req.header('x-s402-tx-digest');

    if (!protocol) return c.json(paymentRequired(body.id), 402);

    if (protocol !== 's402') {
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32601,
          message: `This demo only verifies the s402 protocol. x402 and stripe-mpp protocol objects in the payment[] envelope are for shape demonstration only — verifying them would require an EVM facilitator and a real Stripe API key respectively, both out of scope for this reference impl. Requested protocol: ${protocol}.`
        }
      }, 501);
    }

    if (!txDigest || !(await verifyS402Settlement(txDigest))) {
      return c.json(paymentRequired(body.id), 402);
    }

    const params = body.params as { name: string; arguments: { text: string } };
    const text = params?.arguments?.text ?? '';
    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: summarize(text) }] }
    });
  }

  return c.json({
    jsonrpc: '2.0',
    id: body.id,
    error: { code: -32601, message: 'Method not found' }
  });
});

const PLACEHOLDER_RECEIVER =
  '0x0000000000000000000000000000000000000000000000000000000000000abc';

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`s402 MCP demo server listening on http://localhost:${PORT}`);
  console.log(`  Real Sui testnet settlement: ${REAL_SETTLEMENT ? 'ON' : 'OFF (envelope-only)'}`);
  if (REAL_SETTLEMENT && DEMO_PROVIDER_ADDRESS === PLACEHOLDER_RECEIVER) {
    console.warn(
      '  ⚠ WARNING: Real settlement is ON but receiver is the placeholder address.\n' +
      '    Funds transferred will be unrecoverable. Set SUI_RECEIVER_ADDRESS=0x<your_testnet_wallet> to route to a wallet you control.'
    );
  }
});
