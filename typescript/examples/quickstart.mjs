#!/usr/bin/env node
/**
 * s402 quickstart — the one demo.
 *
 * Runs offline. No keys, no wallet, no network, no Sui node. That is the point:
 * s402 is a wire format, so the thing worth showing a stranger is the wire.
 *
 *   pnpm demo        (from the repo root)
 *
 * Four things get proven, in order:
 *   1. a server builds a 402 and encodes it to a header
 *   2. a client decodes that header and can read what it is being asked to pay
 *   3. an x402 V1 body normalizes into s402 through the compat layer
 *   4. the published conformance vectors run against this build — including
 *      malformed input that MUST be rejected
 *
 * Step 4's second half is the one that matters. A suite that only ever watches
 * things pass cannot tell a working validator from a validator that returns
 * true unconditionally.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { encodePaymentRequired, decodePaymentRequired } from '../dist/index.mjs';
import { normalizeRequirements, isX402 } from '../dist/compat/x402.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, '..', '..', 'spec', 'vectors');

const h1 = (s) => console.log(`\n\x1b[1m${s}\x1b[0m\n${'─'.repeat(s.length)}`);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

let failures = 0;

// ── 1. Server: charge for an endpoint ────────────────────────────────────────
h1('1. A server asks to be paid');

const requirements = {
  s402Version: '1',
  accepts: ['exact', 'stream'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000', // 0.001 SUI, denominated in MIST
  payTo: '0x0000000000000000000000000000000000000000000000000000000000000001',
};

const header = encodePaymentRequired(requirements);
console.log('  HTTP/1.1 402 Payment Required');
console.log(`  payment-required: ${header.slice(0, 64)}…`);
console.log(`  (${header.length} chars of base64 JSON — one header, no body needed)`);

// ── 2. Client: read the 402 ──────────────────────────────────────────────────
h1('2. A client reads it, with no shared code');

const decoded = decodePaymentRequired(header);
console.log(`  wants     : ${decoded.amount} MIST of ${decoded.asset}`);
console.log(`  on        : ${decoded.network}`);
console.log(`  pay to    : ${decoded.payTo.slice(0, 18)}…`);
console.log(`  will take : ${decoded.accepts.join(' or ')}`);

const roundTripped = JSON.stringify(decoded) === JSON.stringify(requirements);
roundTripped ? ok('round-trip is byte-exact') : (failures++, bad('round-trip LOST data'));

// ── 3. Compat: accept an x402 payer ──────────────────────────────────────────
h1('3. An x402 client turns up instead');

const x402Body = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base-mainnet',
  maxAmountRequired: '10000',
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  payTo: '0x0000000000000000000000000000000000000001',
  resource: 'https://api.example.com/data',
};

console.log(`  detected as x402 : ${isX402(x402Body)}`);
const normalized = normalizeRequirements(x402Body);
console.log(`  normalized       : amount=${normalized.amount} network=${normalized.network}`);
isX402(x402Body) && normalized.amount === '10000'
  ? ok('x402 V1 absorbed without the caller knowing which protocol arrived')
  : (failures++, bad('compat normalization did not behave as documented'));

// ── 4. Conformance, both directions ──────────────────────────────────────────
h1('4. The published conformance vectors, run against this build');

const load = (f) => JSON.parse(readFileSync(join(VECTORS, f), 'utf8'));

// 4a. positive — encoding must match the published header byte for byte
const enc = load('requirements-encode.json');
let encPass = 0;
for (const v of enc) {
  if (v.shouldReject) continue;
  if (encodePaymentRequired(v.input) === v.expected.header) encPass++;
  else { failures++; bad(`encode mismatch: ${v.description}`); }
}
ok(`${encPass}/${enc.filter((v) => !v.shouldReject).length} encode vectors match the published bytes`);

// 4b. NEGATIVE CONTROL — malformed input must be refused
const rej = load('validation-reject.json');
let rejected = 0;
let leaked = 0;
for (const v of rej) {
  if (!v.shouldReject || !v.input?.header) continue;
  try {
    decodePaymentRequired(v.input.header);
    leaked++;
    bad(`ACCEPTED malformed input it should have rejected: ${v.description}`);
  } catch {
    rejected++;
  }
}
failures += leaked;
ok(`${rejected} malformed headers refused, ${leaked} leaked through`);
console.log(
  '\n  \x1b[2mThat second number is the one to read. A validator that never\n' +
  '  rejects anything would score full marks on the first.\x1b[0m'
);

// ── verdict ──────────────────────────────────────────────────────────────────
h1('Result');
if (failures === 0) {
  console.log('  \x1b[32mAll checks passed.\x1b[0m Nothing above touched a network or a key.');
  console.log('\n  What this proves: the wire format encodes, decodes, absorbs x402,');
  console.log('  and refuses malformed input — on the code in this clone.');
  console.log('  What it does NOT prove: anything about settlement on Sui.');
  console.log('  That lives in @sweefi/sui and needs a chain. See the README.\n');
} else {
  console.log(`  \x1b[31m${failures} check(s) FAILED.\x1b[0m This build does not match its own published vectors.\n`);
  process.exitCode = 1;
}
