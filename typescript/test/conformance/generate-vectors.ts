/**
 * s402 Conformance Vector Generator
 *
 * Generates JSON test vector files by running the actual s402 encode/decode
 * functions and capturing input/output pairs. Never hand-write base64 strings.
 *
 * Usage: npx tsx test/conformance/generate-vectors.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  encodeRequirementsBody,
  decodeRequirementsBody,
  encodePayloadBody,
  decodePayloadBody,
  encodeSettleBody,
  decodeSettleBody,
} from '../../src/http.js';

import {
  normalizeRequirements,
} from '../../src/compat/x402.js';

import { mcpTransport, a2aTransport } from '../../src/transport.js';

import {
  formatReceiptHeader,
  parseReceiptHeader,
} from '../../src/receipts.js';

import type {
  s402PaymentRequired,
  s402PaymentRequirements,
  s402ResourceInfo,
  s402PaymentPayload,
  s402SettleResponse,
} from '../../src/types.js';

// ── Helpers ──────────────────────────────────────

const VECTORS_DIR = join(import.meta.dirname, '..', '..', '..', 'spec', 'vectors');

interface TestVector {
  description: string;
  input: unknown;
  expected?: unknown;
  shouldReject: boolean;
  expectedErrorCode?: string;
}

function writeVectors(filename: string, vectors: TestVector[]): void {
  writeFileSync(
    join(VECTORS_DIR, filename),
    JSON.stringify(vectors, null, 2) + '\n',
  );
  console.log(`  ${filename}: ${vectors.length} vectors`);
}

/** Unicode-safe base64 encode (mirrors http.ts internal helper) */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
}

// ── Requirements fixtures ────────────────────────

/** Fixed clock for every vector whose expected value would otherwise move. */
const COMPAT_REFERENCE_NOW = 1700000000000; // 2023-11-14T22:13:20Z

const RESOURCE: s402ResourceInfo = {
  url: 'https://api.example.com/paid',
  description: 'Paid content',
  mimeType: 'application/json',
};

/** Wrap one or more offers in the 402 envelope every s402 402 actually is. */
function envelope(
  accepts: s402PaymentRequirements | s402PaymentRequirements[],
  extra?: Partial<Omit<s402PaymentRequired, 'x402Version' | 'accepts'>>,
): s402PaymentRequired {
  return {
    x402Version: 2,
    resource: extra?.resource ?? RESOURCE,
    ...(extra?.error !== undefined ? { error: extra.error } : {}),
    accepts: Array.isArray(accepts) ? accepts : [accepts],
    ...(extra?.extensions !== undefined ? { extensions: extra.extensions } : {}),
    ...(extra?.mandate !== undefined ? { mandate: extra.mandate } : {}),
  };
}

const EXACT_OFFER: s402PaymentRequirements = {
  scheme: 'exact',
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
};

const STREAM_OFFER: s402PaymentRequirements = {
  ...EXACT_OFFER,
  scheme: 'stream',
  stream: {
    ratePerSecond: '1000',
    budgetCap: '100000000',
    minDeposit: '10000000',
  },
};

const ESCROW_OFFER: s402PaymentRequirements = {
  ...EXACT_OFFER,
  scheme: 'escrow',
  escrow: {
    seller: '0xseller1234567890',
    deadlineMs: '1700000000000',
  },
};

const UNLOCK_OFFER: s402PaymentRequirements = {
  ...EXACT_OFFER,
  scheme: 'unlock',
  unlock: {
    packageId: '0xpkg1234567890',
    keyServers: [
      { objectId: '0xks1111', weight: 1 },
      { objectId: '0xks2222', weight: 1 },
    ],
    threshold: 2,
    contentDigest: 'sha256-3q2-7wA_8Xk5cQ0lZ2mN6pR7sT9uV0wX1yZ2aB3cD4',
  },
};

const PREPAID_V02_OFFER: s402PaymentRequirements = {
  ...EXACT_OFFER,
  scheme: 'prepaid',
  prepaid: {
    ratePerCall: '5000',
    minDeposit: '500000',
    withdrawalDelayMs: '3600000',
    providerPubkey: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    disputeWindowMs: '86400000',
  },
};

const PREPAID_V01_OFFER: s402PaymentRequirements = {
  ...EXACT_OFFER,
  scheme: 'prepaid',
  prepaid: {
    ratePerCall: '5000',
    minDeposit: '500000',
    withdrawalDelayMs: '3600000',
  },
};

const UPTO_OFFER: s402PaymentRequirements = {
  ...EXACT_OFFER,
  scheme: 'upto',
  upto: {
    maxAmount: '10000000',
    settlementDeadlineMs: '1700000000000',
    usageReportUrl: 'https://api.example.com/usage',
    estimatedAmount: '7500000',
  },
};

const UPTO_MINIMAL_OFFER: s402PaymentRequirements = {
  ...EXACT_OFFER,
  scheme: 'upto',
  upto: {
    maxAmount: '5000000',
    settlementDeadlineMs: '1700000000000',
  },
};

const MINIMAL_EXACT: s402PaymentRequired = envelope(EXACT_OFFER, { resource: { url: 'https://api.example.com/paid' } });
const WITH_STREAM = envelope(STREAM_OFFER);
const WITH_ESCROW = envelope(ESCROW_OFFER);
const WITH_UNLOCK = envelope(UNLOCK_OFFER);
const WITH_PREPAID_V02 = envelope(PREPAID_V02_OFFER);
const WITH_PREPAID_V01 = envelope(PREPAID_V01_OFFER);
const WITH_UPTO = envelope(UPTO_OFFER);
const WITH_UPTO_MINIMAL = envelope(UPTO_MINIMAL_OFFER);

const WITH_MANDATE = envelope(EXACT_OFFER, {
  mandate: { required: true, minPerTx: '100000' },
});

const WITH_FEES = envelope({
  ...EXACT_OFFER,
  protocolFeeBps: 250,
  protocolFeeAddress: '0xfee_collector_address_1234567890',
});

const WITH_FACILITATOR = envelope({
  ...EXACT_OFFER,
  facilitatorUrl: 'https://facilitator.example.com/settle',
});

const WITH_EXPIRES = envelope({ ...EXACT_OFFER, expiresAt: 1700000000000 });

const WITH_EXTENSIONS = envelope({
  ...EXACT_OFFER,
  extensions: {
    auction: { type: 'sealed-bid', deadline: 1708000000000 },
    customField: 'hello world',
  },
});

const WITH_ENVELOPE_EXTENSIONS = envelope(EXACT_OFFER, {
  extensions: { 'org.example.discovery': { catalog: 'https://api.example.com/.well-known/s402' } },
});

const WITH_DIRECT_SETTLEMENT = envelope({ ...EXACT_OFFER, settlementMode: 'direct' });

const WITH_FACILITATOR_SETTLEMENT = envelope({
  ...EXACT_OFFER,
  settlementMode: 'facilitator',
  facilitatorUrl: 'https://facilitator.example.com/settle',
});

const WITH_RECEIPT_REQUIRED = envelope({ ...EXACT_OFFER, receiptRequired: true });

/**
 * Several schemes on one 402 — one `accepts[]` entry each, `exact` first
 * because an x402 client pays the first entry it can handle.
 */
const WITH_MULTIPLE_SCHEMES = envelope([EXACT_OFFER, PREPAID_V01_OFFER, STREAM_OFFER]);

/** Two networks on one 402 — the offer the flat v1 shape could not express. */
const WITH_TWO_NETWORKS = envelope([
  EXACT_OFFER,
  { ...EXACT_OFFER, network: 'eip155:8453', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '10000' },
]);

/** An x402 requirement's own `extra` keys survive the round trip untouched. */
const WITH_FOREIGN_EXTRA = envelope({
  ...EXACT_OFFER,
  extra: { paymentFlow: 'upfront', name: 'USD Coin', version: '2' },
});

/** A per-entry `maxTimeoutSeconds` other than the default. */
const WITH_TIMEOUT = envelope({ ...EXACT_OFFER, maxTimeoutSeconds: 300 });

const WITH_U64_MAX = envelope({ ...EXACT_OFFER, amount: '18446744073709551615' });

const WITH_ZERO_AMOUNT = envelope({ ...EXACT_OFFER, amount: '0' });

/**
 * A PLAIN x402 V2 402 — no `extensions.s402` anywhere. This is what a server
 * that has never heard of s402 emits, and s402 must decode it into something
 * payable. It is written as raw wire JSON, not built by the encoder, because
 * the point is that nothing of ours produced it.
 */
const PLAIN_X402_V2 = {
  x402Version: 2,
  resource: { url: 'https://x402.example.com/paid' },
  accepts: [{
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: '10000',
    payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  }],
};

// ── Generate requirements-encode.json ────────────

function generateRequirementsEncode(): TestVector[] {
  const fixtures: Array<[string, s402PaymentRequired]> = [
    ['Minimal exact requirements', MINIMAL_EXACT],
    ['Stream scheme with extras', WITH_STREAM],
    ['Upto scheme with estimatedAmount', WITH_UPTO],
    ['Upto scheme minimal (no estimatedAmount)', WITH_UPTO_MINIMAL],
    ['Escrow scheme with extras', WITH_ESCROW],
    ['Unlock scheme with extras', WITH_UNLOCK],
    ['Prepaid v0.2 (providerPubkey + disputeWindowMs)', WITH_PREPAID_V02],
    ['Prepaid v0.1 (no providerPubkey/disputeWindowMs)', WITH_PREPAID_V01],
    ['With mandate (envelope-level, extensions.s402.mandate)', WITH_MANDATE],
    ['With protocolFeeBps and protocolFeeAddress', WITH_FEES],
    ['With facilitatorUrl', WITH_FACILITATOR],
    ['With expiresAt', WITH_EXPIRES],
    ['With per-requirement extensions (extra.extensions)', WITH_EXTENSIONS],
    ['With envelope-level extensions alongside extensions.s402', WITH_ENVELOPE_EXTENSIONS],
    ['With settlementMode: direct', WITH_DIRECT_SETTLEMENT],
    ['With settlementMode: facilitator', WITH_FACILITATOR_SETTLEMENT],
    ['With receiptRequired: true', WITH_RECEIPT_REQUIRED],
    ['Multiple schemes — one accepts[] entry each, exact first', WITH_MULTIPLE_SCHEMES],
    ['Two networks on one 402', WITH_TWO_NETWORKS],
    ["Foreign x402 extra keys pass through this entry's extra", WITH_FOREIGN_EXTRA],
    ['Explicit maxTimeoutSeconds', WITH_TIMEOUT],
    ['Amount at u64 boundary (2^64-1)', WITH_U64_MAX],
    ['Amount of zero', WITH_ZERO_AMOUNT],
  ];

  return fixtures.map(([description, input]) => ({
    description,
    input,
    expected: { header: encodePaymentRequired(input) },
    shouldReject: false,
  }));
}

// ── Generate requirements-decode.json ────────────

function generateRequirementsDecode(): TestVector[] {
  const fixtures: Array<[string, s402PaymentRequired]> = [
    ['Decode minimal exact requirements', MINIMAL_EXACT],
    ['Decode stream scheme', WITH_STREAM],
    ['Decode upto scheme with estimatedAmount', WITH_UPTO],
    ['Decode upto scheme minimal', WITH_UPTO_MINIMAL],
    ['Decode escrow scheme', WITH_ESCROW],
    ['Decode unlock scheme', WITH_UNLOCK],
    ['Decode prepaid v0.2', WITH_PREPAID_V02],
    ['Decode prepaid v0.1', WITH_PREPAID_V01],
    ['Decode with mandate', WITH_MANDATE],
    ['Decode with fees', WITH_FEES],
    ['Decode with facilitatorUrl', WITH_FACILITATOR],
    ['Decode with expiresAt', WITH_EXPIRES],
    ['Decode with per-requirement extensions', WITH_EXTENSIONS],
    ['Decode with envelope-level extensions', WITH_ENVELOPE_EXTENSIONS],
    ['Decode with direct settlement', WITH_DIRECT_SETTLEMENT],
    ['Decode with facilitator settlement', WITH_FACILITATOR_SETTLEMENT],
    ['Decode with receipt required', WITH_RECEIPT_REQUIRED],
    ['Decode with multiple schemes', WITH_MULTIPLE_SCHEMES],
    ['Decode two networks', WITH_TWO_NETWORKS],
    ['Decode foreign x402 extra keys', WITH_FOREIGN_EXTRA],
    ['Decode explicit maxTimeoutSeconds', WITH_TIMEOUT],
    ['Decode u64 max amount', WITH_U64_MAX],
    ['Decode zero amount', WITH_ZERO_AMOUNT],
  ];

  const results: TestVector[] = fixtures.map(([description, input]) => {
    const header = encodePaymentRequired(input);
    const decoded = decodePaymentRequired(header);
    return {
      description,
      input: { header },
      expected: decoded,
      shouldReject: false,
    };
  });

  // THE interop vector: a plain x402 V2 402, carrying no s402 extensions at
  // all, decodes into requirements an s402 client can pay.
  //
  // ⚠️ These carry `now`. A document with no `extensions.s402` gets `expiresAt`
  // DERIVED from `maxTimeoutSeconds` on decode (S1 stale-payment rejection has
  // nothing to read otherwise), and a derivation off the wall clock is not a
  // reproducible vector. Runners must pass `input.now` when it is present.
  const plainHeader = toBase64(JSON.stringify(PLAIN_X402_V2));
  results.push({
    description: 'Decode a plain x402 V2 402 (no extensions.s402) — it is payable as-is',
    input: { header: plainHeader, now: COMPAT_REFERENCE_NOW },
    expected: decodePaymentRequired(plainHeader, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // A scheme this build cannot pay is SKIPPED by the client, never rejected by
  // the decoder — `accepts[]` is a menu (Postel's Law).
  const foreignScheme = {
    ...PLAIN_X402_V2,
    accepts: [
      { ...PLAIN_X402_V2.accepts[0], scheme: 'auth-capture' },
      PLAIN_X402_V2.accepts[0],
    ],
  };
  const foreignHeader = toBase64(JSON.stringify(foreignScheme));
  results.push({
    description: 'Decode an x402 402 offering a scheme s402 does not implement',
    input: { header: foreignHeader, now: COMPAT_REFERENCE_NOW },
    expected: decodePaymentRequired(foreignHeader, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // Key-stripping vector: unknown envelope keys MUST be stripped on decode
  const withUnknownKeys = {
    ...(JSON.parse(JSON.stringify(PLAIN_X402_V2))),
    injectedEvil: 'should be stripped',
    _internal: 'harmless but unknown',
    x_custom_header: 42,
  };
  const unknownHeader = toBase64(JSON.stringify(withUnknownKeys));
  results.push({
    description: 'Decode strips unknown top-level envelope keys',
    input: { header: unknownHeader, now: COMPAT_REFERENCE_NOW },
    expected: decodePaymentRequired(unknownHeader, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // Key-stripping vector: unknown keys inside an accepts[] entry MUST be
  // stripped — but unknown keys inside its `extra` MUST NOT be, because that
  // bag is x402's and open by spec.
  const withUnknownEntryKeys = {
    ...(JSON.parse(JSON.stringify(PLAIN_X402_V2))),
    accepts: [{ ...PLAIN_X402_V2.accepts[0], injectedEntryField: 'stripped' }],
  };
  const unknownEntryHeader = toBase64(JSON.stringify(withUnknownEntryKeys));
  results.push({
    description: 'Decode strips unknown accepts[] entry keys but keeps unknown extra keys',
    input: { header: unknownEntryHeader, now: COMPAT_REFERENCE_NOW },
    expected: decodePaymentRequired(unknownEntryHeader, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // Key-stripping vector: unknown sub-object keys MUST be stripped on decode
  const streamWire = JSON.parse(JSON.stringify(JSON.parse(atob(encodePaymentRequired(WITH_STREAM)))));
  streamWire.accepts[0].extra.stream.injectedField = 'should be stripped from sub-object';
  const unknownSubHeader = toBase64(JSON.stringify(streamWire));
  results.push({
    description: 'Decode strips unknown keys from sub-objects (stream)',
    input: { header: unknownSubHeader },
    expected: decodePaymentRequired(unknownSubHeader),
    shouldReject: false,
  });

  return results;
}

// ── Generate payload-encode.json ─────────────────

function generatePayloadEncode(): TestVector[] {
  const payloads: Array<[string, s402PaymentPayload]> = [
    ['Minimal exact payload', {
      s402Version: '1',
      scheme: 'exact',
      payload: { transaction: 'dHhfYnl0ZXM=', signature: 'c2lnX2J5dGVz' },
    }],
    ['Prepaid payload with ratePerCall', {
      s402Version: '1',
      scheme: 'prepaid',
      payload: {
        transaction: 'dHhfYnl0ZXM=',
        signature: 'c2lnX2J5dGVz',
        ratePerCall: '5000',
        maxCalls: '100',
      },
    }],
    ['Upto payload with maxAmount and settlementCeiling', {
      s402Version: '1',
      scheme: 'upto',
      payload: {
        transaction: 'dXB0b190eA==',
        signature: 'dXB0b19zaWc=',
        maxAmount: '10000000',
        settlementCeiling: '8000000',
      },
    }],
    ['Upto payload without settlementCeiling (backwards compatible)', {
      s402Version: '1',
      scheme: 'upto',
      payload: {
        transaction: 'dXB0b190eA==',
        signature: 'dXB0b19zaWc=',
        maxAmount: '5000000',
      },
    }],
    ['Stream payload', {
      s402Version: '1',
      scheme: 'stream',
      payload: { transaction: 'c3RyZWFtX3R4', signature: 'c3RyZWFtX3NpZw==' },
    }],
    ['Escrow payload', {
      s402Version: '1',
      scheme: 'escrow',
      payload: { transaction: 'ZXNjcm93X3R4', signature: 'ZXNjcm93X3NpZw==' },
    }],
    ['Unlock payload (single-tx pay_and_mint)', {
      s402Version: '1',
      scheme: 'unlock',
      payload: {
        transaction: 'dW5sb2NrX3R4',
        signature: 'dW5sb2NrX3NpZw==',
      },
    }],
    ['Payload with extra x402Version field (encoded but stripped on decode)', {
      s402Version: '1',
      scheme: 'exact',
      payload: { transaction: 'dHhfYnl0ZXM=', signature: 'c2lnX2J5dGVz' },
      x402Version: 1,
    } as unknown as s402PaymentPayload],
    ['Large transaction bytes (base64)', {
      s402Version: '1',
      scheme: 'exact',
      payload: {
        transaction: 'A'.repeat(1000),
        signature: 'B'.repeat(500),
      },
    }],
    ['Prepaid payload with ratePerCall only (no maxCalls)', {
      s402Version: '1',
      scheme: 'prepaid',
      payload: {
        transaction: 'cHJlcGFpZF90eA==',
        signature: 'cHJlcGFpZF9zaWc=',
        ratePerCall: '10000',
      },
    }],
  ];

  return payloads.map(([description, input]) => ({
    description,
    input,
    expected: { header: encodePaymentPayload(input) },
    shouldReject: false,
  }));
}

// ── Generate payload-decode.json ─────────────────

function generatePayloadDecode(): TestVector[] {
  const payloads: Array<[string, s402PaymentPayload]> = [
    ['Decode minimal exact payload', {
      s402Version: '1',
      scheme: 'exact',
      payload: { transaction: 'dHhfYnl0ZXM=', signature: 'c2lnX2J5dGVz' },
    }],
    ['Decode prepaid payload', {
      s402Version: '1',
      scheme: 'prepaid',
      payload: {
        transaction: 'dHhfYnl0ZXM=',
        signature: 'c2lnX2J5dGVz',
        ratePerCall: '5000',
        maxCalls: '100',
      },
    }],
    ['Decode unlock payload', {
      s402Version: '1',
      scheme: 'unlock',
      payload: {
        transaction: 'dW5sb2NrX3R4',
        signature: 'dW5sb2NrX3NpZw==',
      },
    }],
    ['Decode upto payload with settlementCeiling', {
      s402Version: '1',
      scheme: 'upto',
      payload: {
        transaction: 'dXB0b190eA==',
        signature: 'dXB0b19zaWc=',
        maxAmount: '10000000',
        settlementCeiling: '8000000',
      },
    }],
    ['Decode upto payload without settlementCeiling', {
      s402Version: '1',
      scheme: 'upto',
      payload: {
        transaction: 'dXB0b190eA==',
        signature: 'dXB0b19zaWc=',
        maxAmount: '5000000',
      },
    }],
    ['Decode stream payload', {
      s402Version: '1',
      scheme: 'stream',
      payload: { transaction: 'c3RyZWFtX3R4', signature: 'c3RyZWFtX3NpZw==' },
    }],
    ['Decode escrow payload', {
      s402Version: '1',
      scheme: 'escrow',
      payload: { transaction: 'ZXNjcm93X3R4', signature: 'ZXNjcm93X3NpZw==' },
    }],
    ['Decode large transaction', {
      s402Version: '1',
      scheme: 'exact',
      payload: {
        transaction: 'A'.repeat(1000),
        signature: 'B'.repeat(500),
      },
    }],
    // Since wire v2 a 402 may offer the same scheme on several networks, so the
    // scheme name alone cannot say which offer a payment answers. `network` is
    // the disambiguator, and a decoder that strips it hands the gate an
    // ambiguous payment it must refuse (spec §5.1, §10.2).
    ['Decode exact payload carrying the network disambiguator', {
      s402Version: '1',
      scheme: 'exact',
      network: 'sui:mainnet',
      payload: { transaction: 'dHhfYnl0ZXM=', signature: 'c2lnX2J5dGVz' },
    }],
  ];

  const results = payloads.map(([description, input]) => {
    const header = encodePaymentPayload(input);
    const decoded = decodePaymentPayload(header);
    return {
      description,
      input: { header },
      expected: decoded,
      shouldReject: false,
    };
  });

  // Key-stripping vector: unknown top-level keys stripped on payload decode
  const withUnknownKeys = {
    s402Version: '1',
    scheme: 'exact',
    payload: { transaction: 'dHhfYnl0ZXM=', signature: 'c2lnX2J5dGVz' },
    unknownTopLevel: 'should be stripped',
    x402Version: 1,
  };
  const unknownPayloadHeader = toBase64(JSON.stringify(withUnknownKeys));
  results.push({
    description: 'Decode strips unknown top-level keys from payload',
    input: { header: unknownPayloadHeader },
    expected: decodePaymentPayload(unknownPayloadHeader),
    shouldReject: false,
  });

  return results;
}

// ── Generate settle-encode.json ──────────────────

function generateSettleEncode(): TestVector[] {
  const responses: Array<[string, s402SettleResponse]> = [
    ['Success with txDigest and finalityMs', {
      success: true,
      txDigest: 'ABC123digest',
      finalityMs: 450,
    }],
    ['Success with all optional fields', {
      success: true,
      txDigest: 'XYZ789digest',
      receiptId: '0xreceipt123',
      finalityMs: 200,
      streamId: '0xstream456',
    }],
    ['Failure with error message', {
      success: false,
      error: 'Insufficient gas',
      errorCode: 'SETTLEMENT_FAILED',
    }],
    ['Failure with retryable errorCode', {
      success: false,
      error: 'RPC timeout',
      errorCode: 'FINALITY_TIMEOUT',
    }],
    ['Success with balanceId (prepaid)', {
      success: true,
      txDigest: 'prep123',
      balanceId: '0xbalance789',
      finalityMs: 300,
    }],
    ['Success with actualAmount and depositId (upto)', {
      success: true,
      txDigest: 'upto_digest_abc',
      actualAmount: '7500000',
      depositId: '0xdeposit_upto_123',
      finalityMs: 250,
    }],
    ['Success with actualAmount at zero (upto full refund)', {
      success: true,
      txDigest: 'upto_refund_xyz',
      actualAmount: '0',
      depositId: '0xdeposit_refund_456',
      finalityMs: 180,
    }],
  ];

  return responses.map(([description, input]) => ({
    description,
    input,
    expected: { header: encodeSettleResponse(input) },
    shouldReject: false,
  }));
}

// ── Generate settle-decode.json ──────────────────

function generateSettleDecode(): TestVector[] {
  const responses: Array<[string, s402SettleResponse]> = [
    ['Decode success response', {
      success: true,
      txDigest: 'ABC123digest',
      finalityMs: 450,
    }],
    ['Decode failure response', {
      success: false,
      error: 'Insufficient gas',
      errorCode: 'SETTLEMENT_FAILED',
    }],
    ['Decode failure with retryable flag', {
      success: false,
      error: 'RPC timeout',
      errorCode: 'FINALITY_TIMEOUT',
    }],
    ['Decode success with escrowId', {
      success: true,
      txDigest: 'escrow_digest',
      escrowId: '0xescrow123',
      finalityMs: 500,
    }],
    ['Decode success with balanceId', {
      success: true,
      txDigest: 'balance_digest',
      balanceId: '0xbalance456',
      finalityMs: 350,
    }],
    ['Decode success with actualAmount and depositId (upto)', {
      success: true,
      txDigest: 'upto_decode_digest',
      actualAmount: '7500000',
      depositId: '0xdeposit_decode_123',
      finalityMs: 250,
    }],
  ];

  const results = responses.map(([description, input]) => {
    const header = encodeSettleResponse(input);
    const decoded = decodeSettleResponse(header);
    return {
      description,
      input: { header },
      expected: decoded,
      shouldReject: false,
    };
  });

  // Key-stripping vector: unknown top-level keys stripped on settle decode
  const withUnknownKeys = {
    success: true,
    txDigest: 'ABC123',
    finalityMs: 300,
    injectedEvil: 'should be stripped',
    internalNote: 'also stripped',
  };
  const unknownSettleHeader = toBase64(JSON.stringify(withUnknownKeys));
  results.push({
    description: 'Decode strips unknown top-level keys from settle response',
    input: { header: unknownSettleHeader },
    expected: decodeSettleResponse(unknownSettleHeader),
    shouldReject: false,
  });

  return results;
}

// ── Generate body-transport.json ─────────────────

function generateBodyTransport(): TestVector[] {
  const vectors: TestVector[] = [];

  // Requirements body transport
  const reqBody = encodeRequirementsBody(MINIMAL_EXACT);
  const decodedReq = decodeRequirementsBody(reqBody);
  vectors.push({
    description: 'Requirements body encode/decode',
    input: { type: 'requirements', value: MINIMAL_EXACT },
    expected: { body: reqBody, decoded: decodedReq },
    shouldReject: false,
  });

  vectors.push({
    description: 'Requirements body with extensions',
    input: { type: 'requirements', value: WITH_EXTENSIONS },
    expected: {
      body: encodeRequirementsBody(WITH_EXTENSIONS),
      decoded: decodeRequirementsBody(encodeRequirementsBody(WITH_EXTENSIONS)),
    },
    shouldReject: false,
  });

  // Upto requirements body transport (V2)
  vectors.push({
    description: 'Upto requirements body with estimatedAmount',
    input: { type: 'requirements', value: WITH_UPTO },
    expected: {
      body: encodeRequirementsBody(WITH_UPTO),
      decoded: decodeRequirementsBody(encodeRequirementsBody(WITH_UPTO)),
    },
    shouldReject: false,
  });

  // Payload body transport
  const payloadInput: s402PaymentPayload = {
    s402Version: '1',
    scheme: 'exact',
    payload: { transaction: 'dHhfYnl0ZXM=', signature: 'c2lnX2J5dGVz' },
  };
  const payBody = encodePayloadBody(payloadInput);
  const decodedPay = decodePayloadBody(payBody);
  vectors.push({
    description: 'Payload body encode/decode',
    input: { type: 'payload', value: payloadInput },
    expected: { body: payBody, decoded: decodedPay },
    shouldReject: false,
  });

  // Settle body transport
  const settleInput: s402SettleResponse = {
    success: true,
    txDigest: 'ABC123',
    finalityMs: 300,
  };
  const settleBody = encodeSettleBody(settleInput);
  const decodedSettle = decodeSettleBody(settleBody);
  vectors.push({
    description: 'Settle body encode/decode',
    input: { type: 'settle', value: settleInput },
    expected: { body: settleBody, decoded: decodedSettle },
    shouldReject: false,
  });

  // Failure settle via body
  const failSettle: s402SettleResponse = {
    success: false,
    error: 'Gas object not found',
    errorCode: 'SETTLEMENT_FAILED',
  };
  vectors.push({
    description: 'Settle failure body encode/decode',
    input: { type: 'settle', value: failSettle },
    expected: {
      body: encodeSettleBody(failSettle),
      decoded: decodeSettleBody(encodeSettleBody(failSettle)),
    },
    shouldReject: false,
  });

  return vectors;
}

// ── Generate compat-normalize.json ───────────────

// Fixed reference timestamp for deterministic vector generation.
// Tests MUST use this same value when calling normalizeRequirements().
function generateCompatNormalize(): TestVector[] {
  const vectors: TestVector[] = [];

  // x402 V1 flat format
  const x402V1 = {
    x402Version: 1,
    scheme: 'exact',
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xrecipient123',
    maxTimeoutSeconds: 60,
  };
  vectors.push({
    description: 'x402 V1 flat format → s402',
    input: x402V1,
    expected: normalizeRequirements(x402V1 as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 V2 envelope (single offer)
  const x402V2Single = {
    x402Version: 2,
    resource: { url: 'https://api.example.com/paid' },
    accepts: [{
      scheme: 'exact',
      network: 'sui:mainnet',
      asset: '0x2::sui::SUI',
      amount: '2000000',
      payTo: '0xrecipient456',
    }],
  };
  vectors.push({
    description: 'x402 V2 envelope (single offer) → s402',
    input: x402V2Single,
    expected: normalizeRequirements(x402V2Single as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 V2 envelope (multiple offers — ALL kept; wire v2 has room for them)
  const x402V2Multi = {
    x402Version: 2,
    resource: { url: 'https://api.example.com/paid' },
    accepts: [
      {
        scheme: 'exact',
        network: 'sui:mainnet',
        asset: '0x2::sui::SUI',
        amount: '1000000',
        payTo: '0xrecipientFirst',
      },
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: 'USDC',
        amount: '500000',
        payTo: '0xrecipientSecond',
      },
    ],
  };
  vectors.push({
    description: 'x402 V2 envelope (multiple offers) → s402 (first offer taken)',
    input: x402V2Multi,
    expected: normalizeRequirements(x402V2Multi as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 V1 with maxAmountRequired
  const x402V1Max = {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:8453',
    asset: 'USDC',
    maxAmountRequired: '7500000',
    payTo: '0xethRecipient',
  };
  vectors.push({
    description: 'x402 V1 with maxAmountRequired → amount',
    input: x402V1Max,
    expected: normalizeRequirements(x402V1Max as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // Native s402 passed through unchanged
  vectors.push({
    description: 'Native s402 passed through unchanged',
    input: MINIMAL_EXACT,
    expected: normalizeRequirements(MINIMAL_EXACT as unknown as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 V1 with extra unknown fields (stripped)
  const x402WithExtras = {
    x402Version: 1,
    scheme: 'exact',
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xrecipient789',
    unknownField: 'should be stripped',
    anotherRandom: 42,
  };
  vectors.push({
    description: 'x402 V1 with extra unknown fields (stripped)',
    input: x402WithExtras,
    expected: normalizeRequirements(x402WithExtras as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 with facilitatorUrl (SSRF-safe URLs only)
  const x402WithUrl = {
    x402Version: 1,
    scheme: 'exact',
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xrecipientUrl',
    facilitatorUrl: 'https://safe-facilitator.example.com/settle',
  };
  vectors.push({
    description: 'x402 with facilitatorUrl (SSRF-safe HTTPS)',
    input: x402WithUrl,
    expected: normalizeRequirements(x402WithUrl as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 V1 with both amount and maxAmountRequired (amount wins)
  const x402BothAmounts = {
    x402Version: 1,
    scheme: 'exact',
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '2000000',
    maxAmountRequired: '1000000',
    payTo: '0xrecipientBoth',
  };
  vectors.push({
    description: 'x402 V1 with both amount and maxAmountRequired (amount wins)',
    input: x402BothAmounts,
    expected: normalizeRequirements(x402BothAmounts as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 V2 envelope with resource metadata (stripped)
  const x402V2WithResource = {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network: 'sui:mainnet',
      asset: '0x2::sui::SUI',
      amount: '3000000',
      payTo: '0xrecipientRes',
    }],
    // NOTE: this object used to declare `resource` twice — the later one won
    // silently, so the vector always described /data. The dead first copy is
    // removed; the generated vector is unchanged.
    resource: { url: 'https://api.example.com/data', mimeType: 'application/json' },
  };
  vectors.push({
    description: 'x402 V2 envelope with resource metadata',
    input: x402V2WithResource,
    expected: normalizeRequirements(x402V2WithResource as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // x402 with extensions
  const x402WithExtensions = {
    x402Version: 1,
    scheme: 'exact',
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xrecipientExt',
    extensions: { custom: 'data' },
  };
  vectors.push({
    description: 'x402 V1 with extensions preserved',
    input: x402WithExtensions,
    expected: normalizeRequirements(x402WithExtensions as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  // ── s402 v1 (the retired flat shape) ──────────────────────────────────────
  //
  // These are the intake obligation of ADR-013 applied to our OWN past: a
  // pre-wire-v2 s402 server's 402, read by a wire-v2 client. Nothing emits
  // these; everything must still understand them.

  const s402V1Minimal = {
    s402Version: '1',
    accepts: ['exact'],
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  };
  vectors.push({
    description: 's402-v1: minimal flat requirements → one accepts[] entry',
    input: s402V1Minimal,
    expected: normalizeRequirements(s402V1Minimal as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  const s402V1MultiScheme = {
    ...s402V1Minimal,
    accepts: ['prepaid', 'exact', 'stream'],
  };
  vectors.push({
    description: 's402-v1: accepts of scheme names expands to one entry each, exact first',
    input: s402V1MultiScheme,
    expected: normalizeRequirements(s402V1MultiScheme as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  const s402V1Full = {
    ...s402V1Minimal,
    accepts: ['upto'],
    facilitatorUrl: 'https://facilitator.example.com/settle',
    expiresAt: 1700000000000,
    protocolFeeBps: 250,
    protocolFeeAddress: '0xfee_collector',
    receiptRequired: true,
    settlementMode: 'facilitator',
    upto: { maxAmount: '10000000', settlementDeadlineMs: '1700000000000' },
    extensions: { custom: 'data' },
  };
  vectors.push({
    description: 's402-v1: per-requirement fields land in the entry extra',
    input: s402V1Full,
    expected: normalizeRequirements(s402V1Full as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  const s402V1Mandate = {
    ...s402V1Minimal,
    mandate: { required: true, minPerTx: '100000' },
  };
  vectors.push({
    description: 's402-v1: mandate is hoisted to the envelope (extensions.s402.mandate)',
    input: s402V1Mandate,
    expected: normalizeRequirements(s402V1Mandate as Record<string, unknown>, COMPAT_REFERENCE_NOW),
    shouldReject: false,
  });

  return vectors;
}
// ── Generate receipt-format.json ─────────────────

function generateReceiptFormat(): TestVector[] {
  const vectors: TestVector[] = [];

  // Valid receipt
  const sig = new Uint8Array(64).fill(0xAB);
  const hash = new Uint8Array(32).fill(0xCD);
  const receipt1 = {
    signature: sig,
    callNumber: 1n,
    timestampMs: 1700000000000n,
    responseHash: hash,
  };
  vectors.push({
    description: 'Valid v2 receipt header format',
    input: {
      signature: Array.from(sig),
      callNumber: '1',
      timestampMs: '1700000000000',
      responseHash: Array.from(hash),
    },
    expected: { header: formatReceiptHeader(receipt1) },
    shouldReject: false,
  });

  // Different callNumber values
  const receipt2 = { ...receipt1, callNumber: 42n };
  vectors.push({
    description: 'Receipt with callNumber 42',
    input: {
      signature: Array.from(sig),
      callNumber: '42',
      timestampMs: '1700000000000',
      responseHash: Array.from(hash),
    },
    expected: { header: formatReceiptHeader(receipt2) },
    shouldReject: false,
  });

  // Large callNumber
  const receipt3 = { ...receipt1, callNumber: 9007199254740991n };
  vectors.push({
    description: 'Receipt with max safe integer callNumber',
    input: {
      signature: Array.from(sig),
      callNumber: '9007199254740991',
      timestampMs: '1700000000000',
      responseHash: Array.from(hash),
    },
    expected: { header: formatReceiptHeader(receipt3) },
    shouldReject: false,
  });

  // Different timestamp
  const receipt4 = { ...receipt1, timestampMs: 1800000000000n };
  vectors.push({
    description: 'Receipt with different timestamp',
    input: {
      signature: Array.from(sig),
      callNumber: '1',
      timestampMs: '1800000000000',
      responseHash: Array.from(hash),
    },
    expected: { header: formatReceiptHeader(receipt4) },
    shouldReject: false,
  });

  // All-zero signature and hash
  const zeroSig = new Uint8Array(64).fill(0);
  const zeroHash = new Uint8Array(32).fill(0);
  const receipt5 = {
    signature: zeroSig,
    callNumber: 1n,
    timestampMs: 1700000000000n,
    responseHash: zeroHash,
  };
  vectors.push({
    description: 'Receipt with zero-filled signature and hash',
    input: {
      signature: Array.from(zeroSig),
      callNumber: '1',
      timestampMs: '1700000000000',
      responseHash: Array.from(zeroHash),
    },
    expected: { header: formatReceiptHeader(receipt5) },
    shouldReject: false,
  });

  // Large callNumber beyond safe integer
  const receipt6 = { ...receipt1, callNumber: 18446744073709551615n };
  vectors.push({
    description: 'Receipt with u64 max callNumber',
    input: {
      signature: Array.from(sig),
      callNumber: '18446744073709551615',
      timestampMs: '1700000000000',
      responseHash: Array.from(hash),
    },
    expected: { header: formatReceiptHeader(receipt6) },
    shouldReject: false,
  });

  return vectors;
}

// ── Generate receipt-parse.json ──────────────────

function generateReceiptParse(): TestVector[] {
  const vectors: TestVector[] = [];

  const sig = new Uint8Array(64).fill(0xAB);
  const hash = new Uint8Array(32).fill(0xCD);

  // Parse with all fields verified
  const header1 = formatReceiptHeader({
    signature: sig,
    callNumber: 1n,
    timestampMs: 1700000000000n,
    responseHash: hash,
  });
  const parsed1 = parseReceiptHeader(header1);
  vectors.push({
    description: 'Parse valid v2 receipt header',
    input: { header: header1 },
    expected: {
      version: parsed1.version,
      signature: Array.from(parsed1.signature),
      callNumber: parsed1.callNumber.toString(),
      timestampMs: parsed1.timestampMs.toString(),
      responseHash: Array.from(parsed1.responseHash),
    },
    shouldReject: false,
  });

  // Parse with callNumber 42
  const header2 = formatReceiptHeader({
    signature: sig,
    callNumber: 42n,
    timestampMs: 1700000000000n,
    responseHash: hash,
  });
  const parsed2 = parseReceiptHeader(header2);
  vectors.push({
    description: 'Parse receipt with callNumber 42',
    input: { header: header2 },
    expected: {
      version: parsed2.version,
      signature: Array.from(parsed2.signature),
      callNumber: parsed2.callNumber.toString(),
      timestampMs: parsed2.timestampMs.toString(),
      responseHash: Array.from(parsed2.responseHash),
    },
    shouldReject: false,
  });

  // Parse with large callNumber
  const header3 = formatReceiptHeader({
    signature: sig,
    callNumber: 9007199254740991n,
    timestampMs: 1700000000000n,
    responseHash: hash,
  });
  const parsed3 = parseReceiptHeader(header3);
  vectors.push({
    description: 'Parse receipt with max safe integer callNumber',
    input: { header: header3 },
    expected: {
      version: parsed3.version,
      signature: Array.from(parsed3.signature),
      callNumber: parsed3.callNumber.toString(),
      timestampMs: parsed3.timestampMs.toString(),
      responseHash: Array.from(parsed3.responseHash),
    },
    shouldReject: false,
  });

  // Parse with different timestamp
  const header4 = formatReceiptHeader({
    signature: sig,
    callNumber: 1n,
    timestampMs: 1800000000000n,
    responseHash: hash,
  });
  const parsed4 = parseReceiptHeader(header4);
  vectors.push({
    description: 'Parse receipt with different timestamp',
    input: { header: header4 },
    expected: {
      version: parsed4.version,
      signature: Array.from(parsed4.signature),
      callNumber: parsed4.callNumber.toString(),
      timestampMs: parsed4.timestampMs.toString(),
      responseHash: Array.from(parsed4.responseHash),
    },
    shouldReject: false,
  });

  return vectors;
}

// ── Generate validation-reject.json ──────────────

/**
 * Build a raw wire 402 header from flat fields, for rejection vectors.
 *
 * Routing mirrors the codec: the six x402 keys stay on the `accepts[]` entry,
 * `mandate` goes to `extensions.s402`, and everything else drops into the
 * entry's `extra` — which is where every one of those fields now travels.
 */
function wireReject(flat: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  const ext: Record<string, unknown> = { version: '2' };
  for (const [key, value] of Object.entries(flat)) {
    if (['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds'].includes(key)) entry[key] = value;
    else if (key === 'mandate') ext.mandate = value;
    else extra[key] = value;
  }
  entry.extra = extra;
  return toBase64(JSON.stringify({
    x402Version: 2,
    resource: { url: 'https://api.example.com/paid' },
    accepts: [entry],
    extensions: { s402: ext },
  }));
}

function generateValidationReject(): TestVector[] {
  const vectors: TestVector[] = [];

  // Missing s402Version
    // Missing x402Version — an s402 402 is an x402 V2 envelope or it is nothing
  vectors.push({
    description: 'Rejects missing x402Version',
    input: { header: toBase64(JSON.stringify({
      resource: { url: 'https://api.example.com/paid' },
      accepts: [{ scheme: 'exact', network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc', extra: {} }],
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // The retired s402 v1 flat shape is not decoded here — reading it is an
  // intake obligation discharged in compat (fromS402V1Requirements).
  vectors.push({
    description: 'Rejects the retired s402 v1 flat shape',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // x402 V1 (flat) is likewise a compat-layer job, not a native decode
  vectors.push({
    description: 'Rejects x402 V1 flat requirements on the native decode path',
    input: { header: toBase64(JSON.stringify({
      x402Version: 1, scheme: 'exact', network: 'base-sepolia', asset: '0xUSDC',
      maxAmountRequired: '1000', payTo: '0xabc', resource: 'https://api.example.com/paid',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing accepts
  vectors.push({
    description: 'Rejects missing accepts array',
    input: { header: toBase64(JSON.stringify({ x402Version: 2, resource: { url: 'https://api.example.com/paid' } })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Empty accepts array — no offer to match
  vectors.push({
    description: 'Rejects empty accepts array',
    input: { header: toBase64(JSON.stringify({ x402Version: 2, resource: { url: 'https://api.example.com/paid' }, accepts: [] })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing resource — required on every x402 V2 envelope
  vectors.push({
    description: 'Rejects missing resource',
    input: { header: toBase64(JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc', extra: {} }] })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Unsupported envelope version
  vectors.push({
    description: 'Rejects unsupported x402Version 3',
    input: { header: toBase64(JSON.stringify({ x402Version: 3, resource: { url: 'https://api.example.com/paid' }, accepts: [{ scheme: 'exact', network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc', extra: {} }] })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Unsupported s402 wire version inside extensions.s402 (ADR-006 negotiation)
  vectors.push({
    description: 'Rejects unsupported extensions.s402.version',
    input: { header: toBase64(JSON.stringify({
      x402Version: 2, resource: { url: 'https://api.example.com/paid' }, accepts: [{ scheme: 'exact', network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc', extra: {} }],
      extensions: { s402: { version: '3' } },
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // An accepts[] entry with no scheme is not an offer
  vectors.push({
    description: 'Rejects accepts[] entry with no scheme',
    input: { header: toBase64(JSON.stringify({
      x402Version: 2, resource: { url: 'https://api.example.com/paid' },
      accepts: [{ network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc', extra: {} }],
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // accepts[] holding scheme NAMES rather than requirement objects — the
  // retired flat shape smuggled into a v2 envelope
  vectors.push({
    description: 'Rejects accepts[] of scheme name strings',
    input: { header: toBase64(JSON.stringify({ x402Version: 2, resource: { url: 'https://api.example.com/paid' }, accepts: ['exact', 'prepaid'] })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });


  // Missing accepts
  
  // Missing network
  vectors.push({
    description: 'Rejects missing network',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], asset: 'SUI', amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing asset
  vectors.push({
    description: 'Rejects missing asset',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', amount: '1000', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing amount
  vectors.push({
    description: 'Rejects missing amount',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing payTo
  vectors.push({
    description: 'Rejects missing payTo',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI', amount: '1000',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Negative amount
  vectors.push({
    description: 'Rejects negative amount',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '-100', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Non-numeric amount
  vectors.push({
    description: 'Rejects non-numeric amount',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: 'not_a_number', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Leading zeros in amount
  vectors.push({
    description: 'Rejects leading zeros in amount (except "0")',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '007', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Floating point amount
  vectors.push({
    description: 'Rejects floating point amount',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1.5', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // payTo with control characters
  vectors.push({
    description: 'Rejects payTo with control characters',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc\x00def',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // protocolFeeAddress with control characters
  vectors.push({
    description: 'Rejects protocolFeeAddress with control characters',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      protocolFeeAddress: '0xfee\n\rinjection',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Empty payTo
  vectors.push({
    description: 'Rejects empty payTo',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Prepaid pairing violation (providerPubkey without disputeWindowMs)
  vectors.push({
    description: 'Rejects prepaid providerPubkey without disputeWindowMs',
    input: { header: wireReject({
      scheme: 'prepaid', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '3600000',
        providerPubkey: 'abc123',
      },
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Prepaid pairing violation (disputeWindowMs without providerPubkey)
  vectors.push({
    description: 'Rejects prepaid disputeWindowMs without providerPubkey',
    input: { header: wireReject({
      scheme: 'prepaid', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '3600000',
        disputeWindowMs: '86400000',
      },
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // expiresAt that's negative
  vectors.push({
    description: 'Rejects negative expiresAt',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', expiresAt: -1,
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Empty accepts array
  
  // Unsupported s402Version (string "2")
  
  // Unsupported s402Version (numeric, not string)
  
  // protocolFeeBps exceeds 10000
  vectors.push({
    description: 'Rejects protocolFeeBps exceeding 10000',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', protocolFeeBps: 10001,
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // protocolFeeBps negative
  vectors.push({
    description: 'Rejects negative protocolFeeBps',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', protocolFeeBps: -1,
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // protocolFeeBps non-integer
  vectors.push({
    description: 'Rejects non-integer protocolFeeBps',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', protocolFeeBps: 50.5,
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // V2: estimatedAmount > maxAmount
  vectors.push({
    description: 'Rejects upto.estimatedAmount exceeding maxAmount',
    input: { header: wireReject({
      scheme: 'upto', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      upto: {
        maxAmount: '5000000', settlementDeadlineMs: '1700000000000',
        estimatedAmount: '5000001',
      },
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // V2: settlementCeiling = "0" in upto payload (must be >= 1)
  vectors.push({
    description: 'Rejects upto payload with settlementCeiling of zero',
    input: {
      header: toBase64(JSON.stringify({
        s402Version: '1', scheme: 'upto',
        payload: {
          transaction: 'dHg=', signature: 'c2ln',
          maxAmount: '1000000', settlementCeiling: '0',
        },
      })),
      decodeAs: 'payload',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // V2: settlementCeiling > maxAmount in upto payload
  vectors.push({
    description: 'Rejects upto payload with settlementCeiling exceeding maxAmount',
    input: {
      header: toBase64(JSON.stringify({
        s402Version: '1', scheme: 'upto',
        payload: {
          transaction: 'dHg=', signature: 'c2ln',
          maxAmount: '1000000', settlementCeiling: '1000001',
        },
      })),
      decodeAs: 'payload',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // V2: non-string estimatedAmount
  vectors.push({
    description: 'Rejects upto.estimatedAmount as number (must be string)',
    input: { header: wireReject({
      scheme: 'upto', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      upto: {
        maxAmount: '5000000', settlementDeadlineMs: '1700000000000',
        estimatedAmount: 123,
      },
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // V2: non-string settlementCeiling in upto payload
  vectors.push({
    description: 'Rejects upto payload with numeric settlementCeiling (must be string)',
    input: {
      header: toBase64(JSON.stringify({
        s402Version: '1', scheme: 'upto',
        payload: {
          transaction: 'dHg=', signature: 'c2ln',
          maxAmount: '1000000', settlementCeiling: 500000,
        },
      })),
      decodeAs: 'payload',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // M2: prepaid payload ratePerCall must be valid amount (not just a string)
  vectors.push({
    description: 'Rejects prepaid payload with negative ratePerCall',
    input: {
      header: toBase64(JSON.stringify({
        s402Version: '1', scheme: 'prepaid',
        payload: {
          transaction: 'dHg=', signature: 'c2ln',
          ratePerCall: '-5',
        },
      })),
      decodeAs: 'payload',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // M2: prepaid payload maxCalls must be valid amount
  vectors.push({
    description: 'Rejects prepaid payload with non-numeric maxCalls',
    input: {
      header: toBase64(JSON.stringify({
        s402Version: '1', scheme: 'prepaid',
        payload: {
          transaction: 'dHg=', signature: 'c2ln',
          ratePerCall: '100', maxCalls: 'abc',
        },
      })),
      decodeAs: 'payload',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // L1: mandate.minPerTx must be valid amount
  vectors.push({
    description: 'Rejects mandate.minPerTx with leading zeros',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      mandate: { required: true, minPerTx: '007' },
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // M1: settle actualAmount must be string (not number)
  // Note: settle rejection vectors go through decodeSettleResponse, but our
  // conformance runner only dispatches by decodeAs 'payload'/'compat'/receipt.
  // Settle shape validation is covered by unit tests in http.test.ts.

  // S7: Wire format is chain-agnostic — amounts > u64 are valid (needed for EVM u256).
  // Chain-specific magnitude bounds (u64, u256) belong in chain adapters (@sweefi/sui etc.).
  // This vector was previously a rejection case but was changed in v0.2.4 to comply with S7.

  // Invalid base64 (not valid base64 characters)
  vectors.push({
    description: 'Rejects invalid base64 header',
    input: { header: '!!!not+valid+base64!!!' },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Empty string header
  vectors.push({
    description: 'Rejects empty string header',
    input: { header: '' },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Base64 that decodes to non-JSON
  vectors.push({
    description: 'Rejects base64 decoding to non-JSON',
    input: { header: btoa('this is not json at all') },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // SSRF: facilitatorUrl with file:// scheme (rejected by compat normalization)
  vectors.push({
    description: 'Rejects facilitatorUrl with file:// scheme (SSRF)',
    input: {
      header: JSON.stringify({
        x402Version: 1, scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
        amount: '1000', payTo: '0xabc',
        facilitatorUrl: 'file:///etc/passwd',
      }),
      decodeAs: 'compat',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // SSRF: facilitatorUrl with javascript: scheme
  vectors.push({
    description: 'Rejects facilitatorUrl with javascript: scheme (SSRF)',
    input: {
      header: JSON.stringify({
        x402Version: 1, scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
        amount: '1000', payTo: '0xabc',
        facilitatorUrl: 'javascript:alert(1)',
      }),
      decodeAs: 'compat',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Invalid scheme name in payload (goes through decodePaymentPayload, not decodePaymentRequired)
  vectors.push({
    description: 'Rejects invalid scheme name in payload',
    input: {
      header: toBase64(JSON.stringify({
        s402Version: '1', scheme: 'nonexistent_scheme',
        payload: { transaction: 'dHg=', signature: 'c2ln' },
      })),
      decodeAs: 'payload',
    },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Receipt with too few fields (missing responseHash)
  vectors.push({
    description: 'Rejects receipt with too few fields',
    input: { header: 'v2:AAAA:1:1700000000000' },
    shouldReject: true,
    expectedErrorCode: 'RECEIPT_PARSE_ERROR',
  });

  // Receipt with non-numeric callNumber
  vectors.push({
    description: 'Rejects receipt with non-numeric callNumber',
    input: { header: 'v2:AAAA:abc:1700000000000:BBBB' },
    shouldReject: true,
    expectedErrorCode: 'RECEIPT_PARSE_ERROR',
  });

  // Receipt with unknown version prefix
  vectors.push({
    description: 'Rejects receipt with unknown version prefix',
    input: { header: 'v9:AAAA:1:1700000000000:BBBB' },
    shouldReject: true,
    expectedErrorCode: 'RECEIPT_PARSE_ERROR',
  });

  // Receipt with callNumber=0 (must be positive/1-indexed)
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(64).fill(0xAB)));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xCD)));
  vectors.push({
    description: 'Rejects receipt with callNumber 0 (must be positive)',
    input: { header: `v2:${sigB64}:0:1700000000000:${hashB64}` },
    shouldReject: true,
    expectedErrorCode: 'RECEIPT_PARSE_ERROR',
  });

  // Receipt with timestampMs=0 (must be positive)
  vectors.push({
    description: 'Rejects receipt with timestampMs 0 (must be positive)',
    input: { header: `v2:${sigB64}:1:0:${hashB64}` },
    shouldReject: true,
    expectedErrorCode: 'RECEIPT_PARSE_ERROR',
  });

  // Control characters in network field
  vectors.push({
    description: 'Rejects network with control characters',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet\x00',
      asset: 'SUI', amount: '1000', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Control characters in asset field
  vectors.push({
    description: 'Rejects asset with control characters',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet',
      asset: '0x2::sui\n::SUI', amount: '1000', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Control characters in facilitatorUrl (native s402 path)
  vectors.push({
    description: 'Rejects facilitatorUrl with control characters (CRLF injection)',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      facilitatorUrl: 'https://example.com/settle\r\nX-Injected: evil',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // withdrawalDelayMs below minimum (60000ms / 1 min)
  vectors.push({
    description: 'Rejects prepaid withdrawalDelayMs below 60000 (1 min minimum)',
    input: { header: wireReject({
      scheme: 'prepaid', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '59999',
      },
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // withdrawalDelayMs above maximum (604800000ms / 7 days)
  vectors.push({
    description: 'Rejects prepaid withdrawalDelayMs above 604800000 (7 day maximum)',
    input: { header: wireReject({
      scheme: 'prepaid', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '604800001',
      },
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // ── The four places s402's validator was looser than x402 V2's own schema ──
  //
  // Reference: `@x402/core` 2.25.0, `typescript/packages/core/src/schemas/
  // index.ts` — `NetworkSchemaV2` (min 3, must contain ":"), `ResourceInfoSchema`
  // (url non-empty; serviceName 1-32 printable ASCII; tags max 5, each 1-32
  // printable ASCII; iconUrl max 2048), `PaymentRequirementsV2Schema`
  // (maxTimeoutSeconds positive). A 402 that fails any of these is one the
  // pinned upstream decoder refuses, so s402 must not accept it either — in
  // either direction.

  vectors.push({
    description: 'Rejects a network that is not CAIP-2 (x402 V2 requires ":" and 3+ characters)',
    input: { header: wireReject({
      scheme: 'exact', network: 'base-sepolia', asset: 'SUI', amount: '1000', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  vectors.push({
    description: 'Rejects a network shorter than 3 characters',
    input: { header: wireReject({
      scheme: 'exact', network: 'a:', asset: 'SUI', amount: '1000', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  vectors.push({
    description: 'Rejects maxTimeoutSeconds of 0 (x402 V2 requires a positive timeout)',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc',
      maxTimeoutSeconds: 0,
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  vectors.push({
    description: 'Rejects an empty asset',
    input: { header: wireReject({
      scheme: 'exact', network: 'sui:mainnet', asset: '', amount: '1000', payTo: '0xabc',
    }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  /** A wire 402 whose ResourceInfo is the thing under test. */
  const resourceReject = (resource: Record<string, unknown>): string => toBase64(JSON.stringify({
    x402Version: 2,
    resource,
    accepts: [{
      scheme: 'exact', network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', maxTimeoutSeconds: 60, extra: {},
    }],
    extensions: { s402: { version: '2' } },
  }));

  vectors.push({
    description: 'Rejects a resource.serviceName longer than 32 characters',
    input: { header: resourceReject({ url: 'https://api.example.com/paid', serviceName: 'x'.repeat(33) }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  vectors.push({
    description: 'Rejects a resource.serviceName containing non-printable-ASCII characters',
    input: { header: resourceReject({ url: 'https://api.example.com/paid', serviceName: 'Caf\u00e9 Paiement' }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  vectors.push({
    description: 'Rejects more than 5 resource.tags',
    input: { header: resourceReject({ url: 'https://api.example.com/paid', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  vectors.push({
    description: 'Rejects a resource.iconUrl longer than 2048 characters',
    input: { header: resourceReject({ url: 'https://api.example.com/paid', iconUrl: 'https://x/' + 'y'.repeat(2100) }) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  return vectors;
}

// ── Generate roundtrip.json ──────────────────────

function generateRoundtrip(): TestVector[] {
  const vectors: TestVector[] = [];

  // Requirements header roundtrip
  const reqHeader = encodePaymentRequired(MINIMAL_EXACT);
  const reqDecoded = decodePaymentRequired(reqHeader);
  const reqReEncoded = encodePaymentRequired(reqDecoded);
  vectors.push({
    description: 'Requirements header roundtrip: encode → decode → re-encode = identical',
    input: { type: 'requirements', transport: 'header', value: MINIMAL_EXACT },
    expected: {
      firstEncode: reqHeader,
      reEncode: reqReEncoded,
      identical: reqHeader === reqReEncoded,
    },
    shouldReject: false,
  });

  // Requirements body roundtrip
  const reqBodyStr = encodeRequirementsBody(MINIMAL_EXACT);
  const reqBodyDecoded = decodeRequirementsBody(reqBodyStr);
  const reqBodyReEncoded = encodeRequirementsBody(reqBodyDecoded);
  vectors.push({
    description: 'Requirements body roundtrip: encode → decode → re-encode = identical',
    input: { type: 'requirements', transport: 'body', value: MINIMAL_EXACT },
    expected: {
      firstEncode: reqBodyStr,
      reEncode: reqBodyReEncoded,
      identical: reqBodyStr === reqBodyReEncoded,
    },
    shouldReject: false,
  });

  // Payload header roundtrip
  const payloadInput: s402PaymentPayload = {
    s402Version: '1',
    scheme: 'exact',
    payload: { transaction: 'dHhfYnl0ZXM=', signature: 'c2lnX2J5dGVz' },
  };
  const payHeader = encodePaymentPayload(payloadInput);
  const payDecoded = decodePaymentPayload(payHeader);
  const payReEncoded = encodePaymentPayload(payDecoded);
  vectors.push({
    description: 'Payload header roundtrip: encode → decode → re-encode = identical',
    input: { type: 'payload', transport: 'header', value: payloadInput },
    expected: {
      firstEncode: payHeader,
      reEncode: payReEncoded,
      identical: payHeader === payReEncoded,
    },
    shouldReject: false,
  });

  // Payload body roundtrip
  const payBodyStr = encodePayloadBody(payloadInput);
  const payBodyDecoded = decodePayloadBody(payBodyStr);
  const payBodyReEncoded = encodePayloadBody(payBodyDecoded);
  vectors.push({
    description: 'Payload body roundtrip: encode → decode → re-encode = identical',
    input: { type: 'payload', transport: 'body', value: payloadInput },
    expected: {
      firstEncode: payBodyStr,
      reEncode: payBodyReEncoded,
      identical: payBodyStr === payBodyReEncoded,
    },
    shouldReject: false,
  });

  // Settle header roundtrip
  const settleInput: s402SettleResponse = {
    success: true,
    txDigest: 'ABC123',
    finalityMs: 300,
  };
  const settleHeader = encodeSettleResponse(settleInput);
  const settleDecoded = decodeSettleResponse(settleHeader);
  const settleReEncoded = encodeSettleResponse(settleDecoded);
  vectors.push({
    description: 'Settle header roundtrip: encode → decode → re-encode = identical',
    input: { type: 'settle', transport: 'header', value: settleInput },
    expected: {
      firstEncode: settleHeader,
      reEncode: settleReEncoded,
      identical: settleHeader === settleReEncoded,
    },
    shouldReject: false,
  });

  // Settle body roundtrip
  const settleBodyStr = encodeSettleBody(settleInput);
  const settleBodyDecoded = decodeSettleBody(settleBodyStr);
  const settleBodyReEncoded = encodeSettleBody(settleBodyDecoded);
  vectors.push({
    description: 'Settle body roundtrip: encode → decode → re-encode = identical',
    input: { type: 'settle', transport: 'body', value: settleInput },
    expected: {
      firstEncode: settleBodyStr,
      reEncode: settleBodyReEncoded,
      identical: settleBodyStr === settleBodyReEncoded,
    },
    shouldReject: false,
  });

  // Upto requirements roundtrip (V2 fields)
  const uptoHeader = encodePaymentRequired(WITH_UPTO);
  const uptoDecoded = decodePaymentRequired(uptoHeader);
  const uptoReEncoded = encodePaymentRequired(uptoDecoded);
  vectors.push({
    description: 'Upto requirements with estimatedAmount roundtrip',
    input: { type: 'requirements', transport: 'header', value: WITH_UPTO },
    expected: {
      firstEncode: uptoHeader,
      reEncode: uptoReEncoded,
      identical: uptoHeader === uptoReEncoded,
    },
    shouldReject: false,
  });

  // Upto payload roundtrip (with settlementCeiling)
  const uptoPayloadInput: s402PaymentPayload = {
    s402Version: '1',
    scheme: 'upto',
    payload: {
      transaction: 'dXB0b190eA==',
      signature: 'dXB0b19zaWc=',
      maxAmount: '10000000',
      settlementCeiling: '8000000',
    },
  };
  const uptoPayHeader = encodePaymentPayload(uptoPayloadInput);
  const uptoPayDecoded = decodePaymentPayload(uptoPayHeader);
  const uptoPayReEncoded = encodePaymentPayload(uptoPayDecoded);
  vectors.push({
    description: 'Upto payload with settlementCeiling roundtrip',
    input: { type: 'payload', transport: 'header', value: uptoPayloadInput },
    expected: {
      firstEncode: uptoPayHeader,
      reEncode: uptoPayReEncoded,
      identical: uptoPayHeader === uptoPayReEncoded,
    },
    shouldReject: false,
  });

  // Complex requirements with extensions roundtrip
  const complexHeader = encodePaymentRequired(WITH_EXTENSIONS);
  const complexDecoded = decodePaymentRequired(complexHeader);
  const complexReEncoded = encodePaymentRequired(complexDecoded);
  vectors.push({
    description: 'Complex requirements with extensions roundtrip',
    input: { type: 'requirements', transport: 'header', value: WITH_EXTENSIONS },
    expected: {
      firstEncode: complexHeader,
      reEncode: complexReEncoded,
      identical: complexHeader === complexReEncoded,
    },
    shouldReject: false,
  });

  return vectors;
}

// ── Transport carriers (MCP + A2A) ───────────────
// ADR-011: the cross-language contract for the non-HTTP carriers. HTTP is
// already covered by the header/body vectors above (base64 strings); MCP and
// A2A frames are structured JSON objects, captured here directly. The Python
// runner does not yet load this file (it has no MCP/A2A codec) — that is the
// carrier-tagging: the contract exists for when other languages implement it.

function generateTransportCarriers(): TestVector[] {
  const vectors: TestVector[] = [];

  // The round-tripped document, not the authored one: the codec fills in
  // `maxTimeoutSeconds` and `extra` on the way out, so this is the value a
  // decoder actually hands back — and what "round-trips exactly" has to mean.
  const reqs = decodePaymentRequired(encodePaymentRequired(MINIMAL_EXACT));
  const payload: s402PaymentPayload = {
    s402Version: '1',
    scheme: 'exact',
    payload: { transaction: '74785f6578616374', signature: '7369675f6578616374' },
  };
  const settled: s402SettleResponse = { success: true, txDigest: '0x' + 'ab'.repeat(32) };

  // MCP — payment in the JSON-RPC `_meta` slot (structured JSON, not base64).
  vectors.push({
    description: 'MCP requirements: encode → _meta[s402/payment]; decode round-trips; status=required',
    input: { type: 'requirements', carrier: 'mcp', value: reqs },
    expected: { encoded: mcpTransport.encodeRequirements(reqs), status: 'required' },
    shouldReject: false,
  });
  vectors.push({
    description: 'MCP payload: encode → _meta[s402/payment]; decode round-trips; status=submitted',
    input: { type: 'payload', carrier: 'mcp', value: payload },
    expected: { encoded: mcpTransport.encodePayload(payload), status: 'submitted' },
    shouldReject: false,
  });
  vectors.push({
    description: 'MCP settlement: encode → _meta[s402/payment]; decode round-trips; status=completed',
    input: { type: 'settle', carrier: 'mcp', value: settled },
    expected: { encoded: mcpTransport.encodeSettlement(settled), status: 'completed' },
    shouldReject: false,
  });

  // A2A — payment on the task-lifecycle metadata; status is EXPLICIT (read, not derived).
  const a2aCtx = { correlationId: 'task-abc-123' };
  vectors.push({
    description: 'A2A requirements: explicit status + correlation in metadata; decode reads status back',
    input: { type: 'requirements', carrier: 'a2a', value: reqs, correlationId: a2aCtx.correlationId },
    expected: { encoded: a2aTransport.encodeRequirements(reqs, a2aCtx), status: 'required', correlationId: a2aCtx.correlationId },
    shouldReject: false,
  });
  vectors.push({
    description: 'A2A payload: explicit payment-submitted status + correlation; decode round-trips',
    input: { type: 'payload', carrier: 'a2a', value: payload, correlationId: a2aCtx.correlationId },
    expected: { encoded: a2aTransport.encodePayload(payload, a2aCtx), status: 'submitted', correlationId: a2aCtx.correlationId },
    shouldReject: false,
  });
  vectors.push({
    description: 'A2A settlement: receipts array + explicit payment-completed status; decode round-trips',
    input: { type: 'settle', carrier: 'a2a', value: settled, correlationId: a2aCtx.correlationId },
    expected: { encoded: a2aTransport.encodeSettlement(settled, a2aCtx), status: 'completed', correlationId: a2aCtx.correlationId },
    shouldReject: false,
  });

  return vectors;
}

// ── Main ─────────────────────────────────────────

console.log('Generating s402 conformance vectors...\n');

const allVectors: Array<[string, TestVector[]]> = [
  ['requirements-encode.json', generateRequirementsEncode()],
  ['requirements-decode.json', generateRequirementsDecode()],
  ['payload-encode.json', generatePayloadEncode()],
  ['payload-decode.json', generatePayloadDecode()],
  ['settle-encode.json', generateSettleEncode()],
  ['settle-decode.json', generateSettleDecode()],
  ['body-transport.json', generateBodyTransport()],
  ['compat-normalize.json', generateCompatNormalize()],
  ['receipt-format.json', generateReceiptFormat()],
  ['receipt-parse.json', generateReceiptParse()],
  ['validation-reject.json', generateValidationReject()],
  ['roundtrip.json', generateRoundtrip()],
  ['transport-carriers.json', generateTransportCarriers()],
];

let total = 0;
for (const [filename, vectors] of allVectors) {
  writeVectors(filename, vectors);
  total += vectors.length;
}

console.log(`\nTotal: ${total} vectors across ${allVectors.length} files`);

if (total < 64) {
  console.error(`\n⚠️  Only ${total} vectors — minimum is 64!`);
  process.exit(1);
}

console.log('\n✓ All vectors generated successfully');
