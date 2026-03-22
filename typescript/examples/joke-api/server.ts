/**
 * s402 Example: Joke API Server
 *
 * A minimal HTTP server that charges for jokes using the s402 protocol.
 * Uses mock schemes — no Sui connection needed.
 *
 * Run: npx tsx examples/joke-api/server.ts
 */

import { createServer } from 'node:http';
import {
  s402ResourceServer,
  s402Facilitator,
  encodePaymentRequired,
  decodePaymentPayload,
  encodeSettleResponse,
  S402_HEADERS,
} from '../../src/index.js';
import { mockExactServerScheme, mockExactFacilitatorScheme } from '../../src/test-utils.js';

const PORT = 3402;
const NETWORK = 'sui:testnet';
const PAY_TO = '0x' + 'a'.repeat(64);

// ── Wire up mock schemes ──

const server = new s402ResourceServer();
server.register(NETWORK, mockExactServerScheme());

const facilitator = new s402Facilitator();
facilitator.register(NETWORK, mockExactFacilitatorScheme());
server.setFacilitator(facilitator);

// ── Build requirements for the /joke route ──

const requirements = server.buildRequirements({
  schemes: ['exact'],
  price: '1000000', // 0.001 SUI
  network: NETWORK,
  payTo: PAY_TO,
  asset: '0x2::sui::SUI',
});

const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  "There are 10 kinds of people: those who understand binary and those who don't.",
  'A SQL query walks into a bar, sees two tables, and asks: "Can I JOIN you?"',
  'Why was the JavaScript developer sad? Because he didn\'t Node how to Express himself.',
  '!false — it\'s funny because it\'s true.',
];

// ── HTTP server ──

const httpServer = createServer(async (req, res) => {
  if (req.url !== '/joke') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Try GET /joke' }));
    return;
  }

  // Check for payment header
  const paymentHeader = req.headers[S402_HEADERS.PAYMENT] as string | undefined;
  if (!paymentHeader) {
    // No payment — send 402 with requirements
    console.log('← 402 Payment Required');
    res.writeHead(402, {
      [S402_HEADERS.PAYMENT_REQUIRED]: encodePaymentRequired(requirements),
      'content-type': 'text/plain',
    });
    res.end('Payment Required');
    return;
  }

  // Verify + settle payment
  try {
    const payload = decodePaymentPayload(paymentHeader);
    const result = await server.process(payload, requirements);

    if (!result.success) {
      console.log('← 402 Payment failed:', result.error);
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: result.error, errorCode: result.errorCode }));
      return;
    }

    const joke = jokes[Math.floor(Math.random() * jokes.length)];
    console.log(`← 200 OK (tx: ${result.txDigest})`);

    res.writeHead(200, {
      'content-type': 'application/json',
      [S402_HEADERS.PAYMENT_RESPONSE]: encodeSettleResponse(result),
    });
    res.end(JSON.stringify({ joke }));
  } catch (e) {
    console.log('← 400 Bad Request:', String(e));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
});

httpServer.listen(PORT, () => {
  console.log(`\n🎤 Joke API running on http://localhost:${PORT}/joke`);
  console.log(`   Price: ${requirements.amount} MIST (0.001 SUI)`);
  console.log(`   Scheme: exact (mock — no real Sui connection)\n`);
});
