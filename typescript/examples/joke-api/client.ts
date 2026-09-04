/**
 * s402 Example: Joke API Client
 *
 * An AI-agent-style client that auto-pays for jokes.
 * Demonstrates the full 402 flow: request → 402 → pay → retry → 200.
 *
 * Run the server first: npx tsx examples/joke-api/server.ts
 * Then run this:       npx tsx examples/joke-api/client.ts
 */

import {
  s402Client,
  extractRequirementsFromResponse,
  encodePaymentPayload,
  decodeSettleResponse,
  S402_HEADERS,
} from '../../src/index.js';
import { mockExactClientScheme } from '../../src/test-utils.js';

const API_URL = 'http://localhost:3402/joke';
const NETWORK = 'sui:testnet';

// ── Wire up mock client scheme ──

const client = new s402Client();
client.register(NETWORK, mockExactClientScheme());

// ── Agent fetch loop ──

async function getJoke() {
  // 1. Request the resource
  console.log('→ GET /joke');
  const res = await fetch(API_URL);

  if (res.status !== 402) {
    console.log(`  Unexpected status: ${res.status}`);
    console.log(`  Body: ${await res.text()}`);
    return;
  }

  // 2. Decode the 402 requirements
  const requirements = extractRequirementsFromResponse(res);
  if (!requirements) {
    console.log('  No s402 payment requirements in response');
    return;
  }

  console.log('← 402 Payment Required');
  // `accepts` is a list of requirement OBJECTS since wire v2, not scheme names.
  const offer = requirements.accepts[0];
  console.log(`  Schemes: [${requirements.accepts.map((a) => a.scheme).join(', ')}]`);
  console.log(`  Amount:  ${offer.amount} MIST`);
  console.log(`  Network: ${offer.network}`);
  console.log(`  Pay to:  ${offer.payTo.slice(0, 10)}...`);

  // 3. Build payment using registered scheme (auto-selects best match)
  const payload = await client.createPayment(requirements);
  console.log(`  Built ${payload.scheme} payment`);

  // 4. Retry with payment attached
  console.log('→ GET /joke + x-payment');
  const paidRes = await fetch(API_URL, {
    headers: {
      [S402_HEADERS.PAYMENT]: encodePaymentPayload(payload),
    },
  });

  if (paidRes.status === 200) {
    // 5. Read joke + settlement receipt
    const data = await paidRes.json();
    const receiptHeader = paidRes.headers.get(S402_HEADERS.PAYMENT_RESPONSE);
    const receipt = receiptHeader ? decodeSettleResponse(receiptHeader) : null;

    console.log('← 200 OK');
    console.log(`  Joke: ${data.joke}`);
    if (receipt) {
      console.log(`  TX:   ${receipt.txDigest}`);
      console.log(`  Time: ${receipt.finalityMs}ms`);
    }
  } else {
    console.log(`← ${paidRes.status}: ${await paidRes.text()}`);
  }
}

console.log('\n--- s402 Joke API Client ---\n');
getJoke().catch(console.error);
