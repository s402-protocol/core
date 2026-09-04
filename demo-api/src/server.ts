#!/usr/bin/env node

/**
 * s402 Demo API
 *
 * A multi-endpoint demo showcasing the s402 protocol.
 * Uses mock schemes — no real Sui connection needed.
 *
 * Endpoints:
 *   GET /              Landing page (free)
 *   GET /api/catalog   Endpoint catalog (free)
 *   GET /api/joke      0.001 SUI — Random programmer joke
 *   GET /api/wisdom    0.005 SUI — Tech wisdom quote
 *   GET /api/alpha     0.01 SUI  — AI agent payment insights
 *
 * Run:    pnpm dev
 * Deploy: fly deploy
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  s402ResourceServer,
  s402Facilitator,
  encodePaymentRequired,
  decodePaymentPayload,
  encodeSettleResponse,
  parseAcceptPayment,
  formatAcceptPayment,
  selectBestScheme,
  S402_HEADERS,
  S402_VERSION,
} from 's402';
import type {
  s402ServerScheme,
  s402FacilitatorScheme,
  s402RouteConfig,
  s402PaymentRequirements,
  s402PaymentPayload,
  s402ExactPayload,
} from 's402';

// ── Inline Mock Schemes (s402/test-utils not published in npm) ──

function mockExactServerScheme(): s402ServerScheme {
  return {
    scheme: 'exact',
    buildRequirements(config: s402RouteConfig): s402PaymentRequirements {
      // Wire v2: ONE scheme per requirement. The 402's `accepts[]` array is
      // where several offers live, and `buildPaymentRequired` assembles it.
      return {
        scheme: 'exact',
        network: config.network,
        asset: config.asset,
        amount: config.price,
        payTo: config.payTo,
        facilitatorUrl: config.facilitatorUrl,
        protocolFeeBps: config.protocolFeeBps,
        receiptRequired: config.receiptRequired,
        settlementMode: config.settlementMode,
      };
    },
  };
}

function mockExactFacilitatorScheme(): s402FacilitatorScheme {
  return {
    scheme: 'exact',
    async verify(payload: s402PaymentPayload, requirements: s402PaymentRequirements) {
      if (payload.scheme !== 'exact') {
        return { valid: false as const, invalidReason: `Expected exact, got ${payload.scheme}` };
      }
      const exact = payload as s402ExactPayload;
      const expectedTx = `mock-pay-${requirements.amount}-to-${requirements.payTo}`;
      if (exact.payload.transaction !== expectedTx) {
        return { valid: false as const, invalidReason: 'Transaction mismatch' };
      }
      return { valid: true as const, payerAddress: '0xmock-payer' };
    },
    async settle() {
      return { success: true as const, txDigest: 'mock-tx-' + Date.now().toString(36), finalityMs: 50 };
    },
  };
}

// ── Config ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3402', 10);
const NETWORK = process.env.S402_NETWORK || 'sui:testnet';
const PAY_TO = process.env.S402_PAY_TO || '0x' + 'a'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', 'public');

// ── s402 Setup ──────────────────────────────────────────

const resourceServer = new s402ResourceServer();
resourceServer.register(NETWORK, mockExactServerScheme());

const facilitator = new s402Facilitator();
facilitator.register(NETWORK, mockExactFacilitatorScheme());
resourceServer.setFacilitator(facilitator);

// ── Content ─────────────────────────────────────────────

const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  "There are 10 kinds of people: those who understand binary and those who don't.",
  'A SQL query walks into a bar, sees two tables, and asks: "Can I JOIN you?"',
  "Why was the JavaScript developer sad? Because he didn't Node how to Express himself.",
  "!false — it's funny because it's true.",
  "How many programmers does it take to change a light bulb? None — that's a hardware problem.",
  'There are only two hard problems in computer science: cache invalidation, naming things, and off-by-one errors.',
  "A programmer's wife tells him: 'Go to the store and buy a loaf of bread. If they have eggs, buy a dozen.' He comes home with 12 loaves.",
];

const wisdom = [
  { quote: 'The best way to predict the future is to invent it.', author: 'Alan Kay' },
  { quote: 'Simplicity is prerequisite for reliability.', author: 'Edsger Dijkstra' },
  { quote: 'Any fool can write code that a computer can understand. Good programmers write code that humans can understand.', author: 'Martin Fowler' },
  { quote: 'First, solve the problem. Then, write the code.', author: 'John Johnson' },
  { quote: "The most dangerous phrase in the language is: \"We've always done it this way.\"", author: 'Grace Hopper' },
  { quote: 'Programs must be written for people to read, and only incidentally for machines to execute.', author: 'Harold Abelson' },
  { quote: 'Measuring programming progress by lines of code is like measuring aircraft building progress by weight.', author: 'Bill Gates' },
  { quote: 'The function of good software is to make the complex appear to be simple.', author: 'Grady Booch' },
  { quote: 'Make it work, make it right, make it fast.', author: 'Kent Beck' },
  { quote: 'Talk is cheap. Show me the code.', author: 'Linus Torvalds' },
];

const alpha = [
  {
    title: 'The Agent Payment Thesis',
    insight:
      'By 2027, AI agents will make more API calls than humans. HTTP 402 was reserved in 1997 for exactly this moment — machine-to-machine payments at the protocol layer. s402 is the implementation that HTTP has been waiting 30 years for.',
  },
  {
    title: 'The Facilitator Model',
    insight:
      "In s402, facilitators are like Stripe for AI agents — they settle payments so API providers don't need to run blockchain nodes. The default facilitator captures every transaction. This is the Infura playbook: be the invisible infrastructure that everything routes through.",
  },
  {
    title: 'Why Sui Wins for Agent Payments',
    insight:
      "Sui's object model and ~400ms finality make it ideal for micropayments. An agent can pay for an API call and get a response in under a second. Compare that to 12s on Ethereum or 15s on Solana for the same flow. Speed is the product.",
  },
  {
    title: 'The Five Schemes',
    insight:
      's402 defines five payment schemes: exact (one-shot), prepaid (deposit + batch), stream (per-second), escrow (dispute resolution), and unlock (pay-to-decrypt). Most APIs start with exact, but prepaid drops the cost-per-call by 500x for high-frequency access.',
  },
  {
    title: 'MCP as Distribution',
    insight:
      "The Model Context Protocol (MCP) lets AI agents use tools natively. An s402 MCP server means every Claude Code, Cursor, and Copilot user can pay for APIs without writing payment code. Distribution through tool ecosystems is the fastest path to adoption.",
  },
  {
    title: 'The x402 Compatibility Play',
    insight:
      "Coinbase launched x402 for USDC payments. s402 is wire-compatible — same HTTP headers, same flow. But s402 adds four more payment schemes and isn't locked to one chain. Being a superset of a well-funded competitor is the ideal strategic position.",
  },
  {
    title: 'The API Monetization Gap',
    insight:
      'Most APIs today use API keys + monthly billing. This creates friction: signup, credit card, wait for key. With s402, an agent pays per-call with no signup. The API provider earns from the first request. Zero-friction monetization changes which APIs get built.',
  },
  {
    title: 'Agents as Economic Actors',
    insight:
      "When agents have wallets, they become economic actors — not just tools. An agent that can earn, spend, and budget creates fundamentally new workflows. s402 + MCP is the infrastructure layer that makes agents first-class participants in the economy.",
  },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Route Definitions ───────────────────────────────────

interface Route {
  path: string;
  name: string;
  description: string;
  price: string;
  priceDisplay: string;
  content: () => unknown;
}

const routes: Route[] = [
  {
    path: '/api/joke',
    name: 'Programmer Joke',
    description: 'A random programmer joke to brighten your day',
    price: '1000000',
    priceDisplay: '0.001 SUI',
    content: () => ({ joke: pick(jokes) }),
  },
  {
    path: '/api/wisdom',
    name: 'Tech Wisdom',
    description: 'Wisdom from the legends of computing',
    price: '5000000',
    priceDisplay: '0.005 SUI',
    content: () => pick(wisdom),
  },
  {
    path: '/api/alpha',
    name: 'Agent Alpha',
    description: 'Insights on the future of AI agent payments',
    price: '10000000',
    priceDisplay: '0.01 SUI',
    content: () => pick(alpha),
  },
];

// Build s402 requirements for each paid route
const routeMap = new Map(
  routes.map((route) => [
    route.path,
    {
      route,
      // The 402 DOCUMENT for this route — an x402 V2 envelope, `resource` and
      // all — plus the single offer the facilitator settles against.
      required: resourceServer.buildPaymentRequired(
        {
          schemes: ['exact'],
          price: route.price,
          network: NETWORK,
          payTo: PAY_TO,
          asset: '0x2::sui::SUI',
        },
        { url: `http://localhost:${PORT}${route.path}`, description: route.description },
      ),
    },
  ]),
);

// ── Accept-Payment advertisement ────────────────────────

const SUPPORTED_SCHEMES = ['s402/exact'] as const;
const ACCEPT_PAYMENT_HEADER = formatAcceptPayment(
  SUPPORTED_SCHEMES.map((scheme) => ({ scheme, q: 1 })),
);

// ── Stats ───────────────────────────────────────────────

let totalRequests = 0;
let totalPayments = 0;
let totalRevenue = 0n;

// ── HTTP Helpers ────────────────────────────────────────

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-payment, accept-payment, content-type');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'payment-required, x-payment-response, accept-payment',
  );
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

// ── Request Handler ─────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  totalRequests++;

  setCors(res);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Landing page ──
  if (url === '/' || url === '/index.html') {
    try {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
      res.end(html);
    } catch {
      json(res, 500, { error: 'Landing page not found' });
    }
    return;
  }

  // ── Free catalog ──
  if (url === '/api/catalog') {
    json(res, 200, {
      protocol: 's402',
      version: S402_VERSION,
      network: NETWORK,
      endpoints: routes.map((r) => ({
        path: r.path,
        name: r.name,
        description: r.description,
        price: r.price,
        priceDisplay: r.priceDisplay,
        scheme: 'exact',
      })),
      stats: {
        totalRequests,
        totalPayments,
        totalRevenue: totalRevenue.toString(),
      },
      tryIt: 'Configure @sweefi/mcp in Claude Code, then ask it to fetch any endpoint above.',
    });
    return;
  }

  // ── Stats ──
  if (url === '/api/stats') {
    json(res, 200, { totalRequests, totalPayments, totalRevenue: totalRevenue.toString() });
    return;
  }

  // ── Paid routes ──
  const entry = routeMap.get(url);
  if (!entry) {
    json(res, 404, { error: 'Not found', hint: 'GET /api/catalog for available endpoints' });
    return;
  }

  const { route, required } = entry;
  const requirements = required.accepts[0];
  const paymentHeader = req.headers[S402_HEADERS.PAYMENT] as string | undefined;
  const acceptPaymentHeader = req.headers[S402_HEADERS.ACCEPT_PAYMENT] as string | undefined;
  const clientPreferences = parseAcceptPayment(acceptPaymentHeader);
  const negotiated = selectBestScheme(clientPreferences, SUPPORTED_SCHEMES);

  // No payment → 402
  if (!paymentHeader) {
    console.log(
      `  402 ${route.path} → ${route.priceDisplay}${negotiated ? ` (negotiated ${negotiated})` : ''}`,
    );
    res.writeHead(402, {
      [S402_HEADERS.PAYMENT_REQUIRED]: encodePaymentRequired(required),
      [S402_HEADERS.ACCEPT_PAYMENT]: ACCEPT_PAYMENT_HEADER,
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(
      JSON.stringify(
        {
          error: 'Payment Required',
          endpoint: route.name,
          price: route.priceDisplay,
          priceMist: route.price,
          scheme: 'exact',
          network: NETWORK,
          docs: 'https://s402-protocol.org',
        },
        null,
        2,
      ),
    );
    return;
  }

  // Has payment → verify + settle + serve
  try {
    const payload = decodePaymentPayload(paymentHeader);
    const result = await resourceServer.process(payload, requirements);

    if (!result.success) {
      console.log(`  402 ${route.path} payment failed: ${result.error}`);
      json(res, 402, { error: result.error, errorCode: result.errorCode });
      return;
    }

    totalPayments++;
    totalRevenue += BigInt(route.price);

    const content = route.content();
    console.log(`  200 ${route.path} (tx: ${result.txDigest})`);

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      [S402_HEADERS.PAYMENT_RESPONSE]: encodeSettleResponse(result),
    });
    res.end(JSON.stringify(content, null, 2));
  } catch (e) {
    console.log(`  400 ${route.path}: ${e}`);
    json(res, 400, { error: String(e) });
  }
}

// ── Start ───────────────────────────────────────────────

const httpServer = createServer(handleRequest);

httpServer.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────────────┐
  │  s402 Demo API                               │
  │  http://localhost:${String(PORT).padEnd(29)}│
  │                                              │
  │  GET /              Landing page      free   │
  │  GET /api/catalog   Endpoint list     free   │
  │  GET /api/joke      Programmer joke   0.001  │
  │  GET /api/wisdom    Tech wisdom       0.005  │
  │  GET /api/alpha     Agent insights    0.01   │
  │                                              │
  │  Network: ${NETWORK.padEnd(34)}│
  │  Schemes: mock (no real Sui needed)          │
  └──────────────────────────────────────────────┘
  `);
});
