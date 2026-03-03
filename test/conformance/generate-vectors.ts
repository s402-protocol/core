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
} from '../../src/compat.js';

import {
  formatReceiptHeader,
  parseReceiptHeader,
} from '../../src/receipts.js';

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
} from '../../src/types.js';

// ── Helpers ──────────────────────────────────────

const VECTORS_DIR = join(import.meta.dirname, 'vectors');

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

const MINIMAL_EXACT: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
};

const WITH_STREAM: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  accepts: ['stream'],
  stream: {
    ratePerSecond: '1000',
    budgetCap: '100000000',
    minDeposit: '10000000',
  },
};

const WITH_ESCROW: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  accepts: ['escrow'],
  escrow: {
    seller: '0xseller1234567890',
    deadlineMs: '1700000000000',
  },
};

const WITH_UNLOCK: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  accepts: ['unlock'],
  unlock: {
    encryptionId: 'enc-abc-123',
    walrusBlobId: 'blob-xyz-789',
    encryptionPackageId: '0xpkg1234567890',
  },
};

const WITH_PREPAID_V02: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  accepts: ['prepaid'],
  prepaid: {
    ratePerCall: '5000',
    minDeposit: '500000',
    withdrawalDelayMs: '3600000',
    providerPubkey: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    disputeWindowMs: '86400000',
  },
};

const WITH_PREPAID_V01: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  accepts: ['prepaid'],
  prepaid: {
    ratePerCall: '5000',
    minDeposit: '500000',
    withdrawalDelayMs: '3600000',
  },
};

const WITH_MANDATE: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  mandate: {
    required: true,
    minPerTx: '100000',
  },
};

const WITH_FEES: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  protocolFeeBps: 250,
  protocolFeeAddress: '0xfee_collector_address_1234567890',
};

const WITH_FACILITATOR: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  facilitatorUrl: 'https://facilitator.example.com/settle',
};

const WITH_EXPIRES: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  expiresAt: 1700000000000,
};

const WITH_EXTENSIONS: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  extensions: {
    auction: { type: 'sealed-bid', deadline: 1708000000000 },
    customField: 'hello world',
  },
};

const WITH_DIRECT_SETTLEMENT: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  settlementMode: 'direct',
};

const WITH_FACILITATOR_SETTLEMENT: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  settlementMode: 'facilitator',
  facilitatorUrl: 'https://facilitator.example.com/settle',
};

const WITH_RECEIPT_REQUIRED: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  receiptRequired: true,
};

const WITH_MULTIPLE_SCHEMES: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  accepts: ['exact', 'prepaid', 'stream'],
};

const WITH_U64_MAX: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  amount: '18446744073709551615',
};

const WITH_ZERO_AMOUNT: s402PaymentRequirements = {
  ...MINIMAL_EXACT,
  amount: '0',
};

// ── Generate requirements-encode.json ────────────

function generateRequirementsEncode(): TestVector[] {
  const fixtures: Array<[string, s402PaymentRequirements]> = [
    ['Minimal exact requirements', MINIMAL_EXACT],
    ['Stream scheme with extras', WITH_STREAM],
    ['Escrow scheme with extras', WITH_ESCROW],
    ['Unlock scheme with extras', WITH_UNLOCK],
    ['Prepaid v0.2 (providerPubkey + disputeWindowMs)', WITH_PREPAID_V02],
    ['Prepaid v0.1 (no providerPubkey/disputeWindowMs)', WITH_PREPAID_V01],
    ['With mandate (required: true, minPerTx set)', WITH_MANDATE],
    ['With protocolFeeBps and protocolFeeAddress', WITH_FEES],
    ['With facilitatorUrl', WITH_FACILITATOR],
    ['With expiresAt', WITH_EXPIRES],
    ['With extensions (unknown fields preserved)', WITH_EXTENSIONS],
    ['With settlementMode: direct', WITH_DIRECT_SETTLEMENT],
    ['With settlementMode: facilitator', WITH_FACILITATOR_SETTLEMENT],
    ['With receiptRequired: true', WITH_RECEIPT_REQUIRED],
    ['Multiple schemes in accepts array', WITH_MULTIPLE_SCHEMES],
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
  const fixtures: Array<[string, s402PaymentRequirements]> = [
    ['Decode minimal exact requirements', MINIMAL_EXACT],
    ['Decode stream scheme', WITH_STREAM],
    ['Decode escrow scheme', WITH_ESCROW],
    ['Decode unlock scheme', WITH_UNLOCK],
    ['Decode prepaid v0.2', WITH_PREPAID_V02],
    ['Decode prepaid v0.1', WITH_PREPAID_V01],
    ['Decode with mandate', WITH_MANDATE],
    ['Decode with fees', WITH_FEES],
    ['Decode with facilitatorUrl', WITH_FACILITATOR],
    ['Decode with expiresAt', WITH_EXPIRES],
    ['Decode with extensions', WITH_EXTENSIONS],
    ['Decode with direct settlement', WITH_DIRECT_SETTLEMENT],
    ['Decode with facilitator settlement', WITH_FACILITATOR_SETTLEMENT],
    ['Decode with receipt required', WITH_RECEIPT_REQUIRED],
    ['Decode with multiple schemes', WITH_MULTIPLE_SCHEMES],
    ['Decode u64 max amount', WITH_U64_MAX],
    ['Decode zero amount', WITH_ZERO_AMOUNT],
  ];

  const results = fixtures.map(([description, input]) => {
    const header = encodePaymentRequired(input);
    const decoded = decodePaymentRequired(header);
    return {
      description,
      input: { header },
      expected: decoded,
      shouldReject: false,
    };
  });

  // Key-stripping vector: unknown top-level keys MUST be stripped on decode
  const withUnknownKeys = {
    ...MINIMAL_EXACT,
    injectedEvil: 'should be stripped',
    _internal: 'harmless but unknown',
    x_custom_header: 42,
  };
  const unknownHeader = toBase64(JSON.stringify(withUnknownKeys));
  results.push({
    description: 'Decode strips unknown top-level keys',
    input: { header: unknownHeader },
    expected: decodePaymentRequired(unknownHeader),
    shouldReject: false,
  });

  // Key-stripping vector: unknown sub-object keys MUST be stripped on decode
  const withUnknownSubKeys = {
    ...WITH_STREAM,
    stream: {
      ...WITH_STREAM.stream,
      injectedField: 'should be stripped from sub-object',
    },
  };
  const unknownSubHeader = toBase64(JSON.stringify(withUnknownSubKeys));
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
    ['Unlock payload with encryptionId', {
      s402Version: '1',
      scheme: 'unlock',
      payload: {
        transaction: 'dW5sb2NrX3R4',
        signature: 'dW5sb2NrX3NpZw==',
        encryptionId: 'enc-abc-123',
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
        encryptionId: 'enc-abc-123',
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
    expected: normalizeRequirements(x402V1 as Record<string, unknown>),
    shouldReject: false,
  });

  // x402 V2 envelope (single offer)
  const x402V2Single = {
    x402Version: 2,
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
    expected: normalizeRequirements(x402V2Single as Record<string, unknown>),
    shouldReject: false,
  });

  // x402 V2 envelope (multiple offers — first taken)
  const x402V2Multi = {
    x402Version: 2,
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
    expected: normalizeRequirements(x402V2Multi as Record<string, unknown>),
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
    expected: normalizeRequirements(x402V1Max as Record<string, unknown>),
    shouldReject: false,
  });

  // Native s402 passed through unchanged
  vectors.push({
    description: 'Native s402 passed through unchanged',
    input: MINIMAL_EXACT,
    expected: normalizeRequirements(MINIMAL_EXACT as unknown as Record<string, unknown>),
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
    expected: normalizeRequirements(x402WithExtras as Record<string, unknown>),
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
    expected: normalizeRequirements(x402WithUrl as Record<string, unknown>),
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
    expected: normalizeRequirements(x402BothAmounts as Record<string, unknown>),
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
    resource: { url: 'https://api.example.com/data', mimeType: 'application/json' },
  };
  vectors.push({
    description: 'x402 V2 envelope with resource metadata',
    input: x402V2WithResource,
    expected: normalizeRequirements(x402V2WithResource as Record<string, unknown>),
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
    expected: normalizeRequirements(x402WithExtensions as Record<string, unknown>),
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

function generateValidationReject(): TestVector[] {
  const vectors: TestVector[] = [];

  // Missing s402Version
  vectors.push({
    description: 'Rejects missing s402Version',
    input: { header: toBase64(JSON.stringify({
      accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing accepts
  vectors.push({
    description: 'Rejects missing accepts array',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', network: 'sui:mainnet', asset: 'SUI', amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

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
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing amount
  vectors.push({
    description: 'Rejects missing amount',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Missing payTo
  vectors.push({
    description: 'Rejects missing payTo',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI', amount: '1000',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Negative amount
  vectors.push({
    description: 'Rejects negative amount',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '-100', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Non-numeric amount
  vectors.push({
    description: 'Rejects non-numeric amount',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: 'not_a_number', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Leading zeros in amount
  vectors.push({
    description: 'Rejects leading zeros in amount (except "0")',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '007', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Floating point amount
  vectors.push({
    description: 'Rejects floating point amount',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1.5', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // payTo with control characters
  vectors.push({
    description: 'Rejects payTo with control characters',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc\x00def',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // protocolFeeAddress with control characters
  vectors.push({
    description: 'Rejects protocolFeeAddress with control characters',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      protocolFeeAddress: '0xfee\n\rinjection',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Empty payTo
  vectors.push({
    description: 'Rejects empty payTo',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Prepaid pairing violation (providerPubkey without disputeWindowMs)
  vectors.push({
    description: 'Rejects prepaid providerPubkey without disputeWindowMs',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['prepaid'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '3600000',
        providerPubkey: 'abc123',
      },
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Prepaid pairing violation (disputeWindowMs without providerPubkey)
  vectors.push({
    description: 'Rejects prepaid disputeWindowMs without providerPubkey',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['prepaid'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '3600000',
        disputeWindowMs: '86400000',
      },
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // expiresAt that's negative
  vectors.push({
    description: 'Rejects negative expiresAt',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', expiresAt: -1,
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Empty accepts array
  vectors.push({
    description: 'Rejects empty accepts array',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: [], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Unsupported s402Version (string "2")
  vectors.push({
    description: 'Rejects unsupported s402Version "2"',
    input: { header: toBase64(JSON.stringify({
      s402Version: '2', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Unsupported s402Version (numeric, not string)
  vectors.push({
    description: 'Rejects numeric s402Version (must be string "1")',
    input: { header: toBase64(JSON.stringify({
      s402Version: 1, accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // protocolFeeBps exceeds 10000
  vectors.push({
    description: 'Rejects protocolFeeBps exceeding 10000',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', protocolFeeBps: 10001,
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // protocolFeeBps negative
  vectors.push({
    description: 'Rejects negative protocolFeeBps',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', protocolFeeBps: -1,
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // protocolFeeBps non-integer
  vectors.push({
    description: 'Rejects non-integer protocolFeeBps',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc', protocolFeeBps: 50.5,
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Amount exceeding u64 max (2^64)
  vectors.push({
    description: 'Rejects amount exceeding u64 max',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '18446744073709551616', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

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
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet\x00',
      asset: 'SUI', amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Control characters in asset field
  vectors.push({
    description: 'Rejects asset with control characters',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet',
      asset: '0x2::sui\n::SUI', amount: '1000', payTo: '0xabc',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // Control characters in facilitatorUrl (native s402 path)
  vectors.push({
    description: 'Rejects facilitatorUrl with control characters (CRLF injection)',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['exact'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      facilitatorUrl: 'https://example.com/settle\r\nX-Injected: evil',
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // withdrawalDelayMs below minimum (60000ms / 1 min)
  vectors.push({
    description: 'Rejects prepaid withdrawalDelayMs below 60000 (1 min minimum)',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['prepaid'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '59999',
      },
    })) },
    shouldReject: true,
    expectedErrorCode: 'INVALID_PAYLOAD',
  });

  // withdrawalDelayMs above maximum (604800000ms / 7 days)
  vectors.push({
    description: 'Rejects prepaid withdrawalDelayMs above 604800000 (7 day maximum)',
    input: { header: toBase64(JSON.stringify({
      s402Version: '1', accepts: ['prepaid'], network: 'sui:mainnet', asset: 'SUI',
      amount: '1000', payTo: '0xabc',
      prepaid: {
        ratePerCall: '100', minDeposit: '10000', withdrawalDelayMs: '604800001',
      },
    })) },
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
