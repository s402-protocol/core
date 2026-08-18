/**
 * Network-resolution conformance for s402/compat/mpp — DAN-848.
 *
 * Separate from `compat-mpp.test.ts` on purpose. That file greps positive for
 * `solana`, but every hit is inside a `parseMppAcceptPayment` test — no Solana
 * challenge has ever reached `fromMppChargeChallenge`. The gap was camouflaged
 * rather than absent, which is how it survived review. This file's name states
 * the axis it covers so the distinction is visible from the directory listing.
 *
 * Every fixture is the method spec's own example, cited inline:
 *   - Solana:    specs/methods/solana/draft-solana-charge-00.md    §Method Details
 *   - Lightning: specs/methods/lightning/draft-lightning-charge-00.md §Method Details
 *   - Stellar:   specs/methods/stellar/draft-stellar-charge-00.md   §Method Details
 *   - Tempo:     specs/methods/tempo/draft-tempo-charge-00.md       §Request Schema
 *   - EVM:       specs/methods/evm/draft-evm-charge-00.md           §Method Details
 * (tempoxyz/mpp-specs @ f9506cd)
 */
import { describe, it, expect } from 'vitest';
import { fromMppChargeChallenge, type MppChallenge } from '../src/compat/mpp.js';
import { s402Error } from '../src/errors.js';

function base64url(input: string): string {
  const b64 = Buffer.from(input, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const FUTURE = new Date(Date.UTC(2099, 0, 15, 12, 5, 0)).toISOString();

/** Build a charge challenge for `method` carrying `request` as its JCS payload. */
function challenge(method: string, request: Record<string, unknown>): MppChallenge {
  return {
    id: 'ch_1',
    realm: 'api.example.com',
    method,
    intent: 'charge',
    request: base64url(JSON.stringify(request)),
    expires: FUTURE,
  };
}

// Solana native-SOL example, spec §Native SOL Example. `network` lives under
// methodDetails and is the field the spec obliges a client to compare against
// its configured cluster.
const solana = (methodDetails: Record<string, unknown>) =>
  challenge('solana', {
    amount: '10000000',
    currency: 'sol',
    recipient: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    description: 'Weather API access',
    methodDetails,
  });

// Lightning example, spec §Decoded request. NOTE: the spec's own example omits
// `recipient` (OPTIONAL for lightning — "the invoice payee is implied by the
// BOLT11 invoice"), and `fromMppChargeChallenge` currently rejects that shape.
// That is a separate defect from network resolution; these fixtures supply a
// recipient so this file tests exactly one axis.
const lightning = (methodDetails: Record<string, unknown>) =>
  challenge('lightning', {
    amount: '100',
    currency: 'sat',
    recipient: '03a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    description: 'Weather report for 94107',
    methodDetails: { invoice: 'lnbc1u1p...', ...methodDetails },
  });

const stellar = (methodDetails: Record<string, unknown>) =>
  challenge('stellar', {
    amount: '10000000',
    currency: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4W',
    recipient: 'GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU',
    methodDetails,
  });

const tempo = (methodDetails: Record<string, unknown>) =>
  challenge('tempo', {
    amount: '1000000',
    currency: '0x20c0000000000000000000000000000000000000',
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    methodDetails,
  });

const evm = (methodDetails: Record<string, unknown>) =>
  challenge('evm', {
    amount: '1000',
    currency: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    methodDetails,
  });

// ══════════════════════════════════════════════════════════════
// Finding 1 — the whole of it, in one assertion
// ══════════════════════════════════════════════════════════════

describe('Solana cluster discriminator', () => {
  it('does not collapse devnet and mainnet into the same network', () => {
    // The spec: "Clients MUST reject challenges whose network does not match
    // their configured cluster." A comparison is impossible while both sides
    // stringify identically.
    expect(fromMppChargeChallenge(solana({ network: 'devnet' })).network)
      .not.toBe(fromMppChargeChallenge(solana({ network: 'mainnet' })).network);
  });

  it('resolves each spec-enumerated cluster', () => {
    expect(fromMppChargeChallenge(solana({ network: 'mainnet' })).network).toBe('solana:mainnet');
    expect(fromMppChargeChallenge(solana({ network: 'devnet' })).network).toBe('solana:devnet');
    expect(fromMppChargeChallenge(solana({ network: 'localnet' })).network).toBe('solana:localnet');
  });

  it('applies the spec default "mainnet" when network is omitted', () => {
    // `network` is OPTIONAL and defaults to mainnet — omission is the common
    // case, so a default that is not applied is the reachable bug.
    expect(fromMppChargeChallenge(solana({ decimals: 6 })).network).toBe('solana:mainnet');
    expect(fromMppChargeChallenge(solana({})).network).toBe('solana:mainnet');
  });

  it('rejects a cluster outside the spec enumeration rather than relabelling it', () => {
    expect(() => fromMppChargeChallenge(solana({ network: 'testnet' }))).toThrow(s402Error);
    expect(() => fromMppChargeChallenge(solana({ network: 'testnet' }))).toThrow(/solana/i);
    expect(() => fromMppChargeChallenge(solana({ network: 42 }))).toThrow(s402Error);
  });
});

// ══════════════════════════════════════════════════════════════
// Finding 1's twin — same class, milder consequence, hidden by the ranking
// ══════════════════════════════════════════════════════════════

describe('Lightning network discriminator', () => {
  it('does not collapse regtest and mainnet into the same network', () => {
    expect(fromMppChargeChallenge(lightning({ network: 'regtest' })).network)
      .not.toBe(fromMppChargeChallenge(lightning({ network: 'mainnet' })).network);
  });

  it('resolves each spec-enumerated network', () => {
    expect(fromMppChargeChallenge(lightning({ network: 'mainnet' })).network).toBe('lightning:mainnet');
    expect(fromMppChargeChallenge(lightning({ network: 'regtest' })).network).toBe('lightning:regtest');
    expect(fromMppChargeChallenge(lightning({ network: 'signet' })).network).toBe('lightning:signet');
  });

  it('applies the spec default "mainnet" when network is omitted', () => {
    expect(fromMppChargeChallenge(lightning({})).network).toBe('lightning:mainnet');
  });

  it('rejects a network outside the spec enumeration (Lightning has no "devnet")', () => {
    expect(() => fromMppChargeChallenge(lightning({ network: 'devnet' }))).toThrow(s402Error);
  });
});

// ══════════════════════════════════════════════════════════════
// Methods whose discriminator was already CAIP-2 or already defaulted
// ══════════════════════════════════════════════════════════════

describe('Stellar network discriminator', () => {
  it('passes the CAIP-2 identifier through unchanged', () => {
    // methodDetails.network is REQUIRED for stellar and is *already* a CAIP-2
    // identifier — the value the resolver needs was on the wire the whole time.
    expect(fromMppChargeChallenge(stellar({ network: 'stellar:testnet' })).network)
      .toBe('stellar:testnet');
    expect(fromMppChargeChallenge(stellar({ network: 'stellar:pubnet', feePayer: true })).network)
      .toBe('stellar:pubnet');
  });

  it('rejects a challenge missing the REQUIRED network field', () => {
    expect(() => fromMppChargeChallenge(stellar({ feePayer: true }))).toThrow(s402Error);
  });
});

describe('Tempo chain-id default', () => {
  it('applies the spec default 42431 when chainId is omitted', () => {
    expect(fromMppChargeChallenge(tempo({ feePayer: true })).network).toBe('tempo:42431');
  });

  it('still honours an explicit chainId', () => {
    expect(fromMppChargeChallenge(tempo({ chainId: 4217 })).network).toBe('tempo:4217');
    expect(fromMppChargeChallenge(tempo({ chainId: '4217' })).network).toBe('tempo:4217');
  });

  it('rejects a malformed chainId rather than falling back to the default', () => {
    // Falling back would mean a challenge naming an unparseable chain silently
    // becomes a mainnet payment.
    expect(() => fromMppChargeChallenge(tempo({ chainId: 'mainnet' }))).toThrow(s402Error);
    expect(() => fromMppChargeChallenge(tempo({ chainId: -1 }))).toThrow(s402Error);
  });
});

describe('EVM chain-id', () => {
  it('resolves via eip155:{chainId}', () => {
    expect(fromMppChargeChallenge(evm({ chainId: 8453 })).network).toBe('eip155:8453');
  });

  it('rejects a challenge missing the REQUIRED chainId', () => {
    // evm's chainId is REQUIRED and the spec obliges clients to reject chains
    // they do not support — a requirement carrying an unnamed chain cannot be
    // checked against anything.
    expect(() => fromMppChargeChallenge(evm({}))).toThrow(s402Error);
  });
});

// ══════════════════════════════════════════════════════════════
// The set is closed — `${method}:unknown` has no producer left
// ══════════════════════════════════════════════════════════════

describe('no challenge lifts with an unresolved network', () => {
  const everyMappableMethod: Array<[string, MppChallenge]> = [
    ['solana', solana({})],
    ['lightning', lightning({})],
    ['stellar', stellar({ network: 'stellar:pubnet' })],
    ['tempo', tempo({})],
    ['evm', evm({ chainId: 1 })],
  ];

  it.each(everyMappableMethod)('%s resolves to a named network', (_method, ch) => {
    expect(fromMppChargeChallenge(ch).network).not.toMatch(/:unknown$/);
  });

  it('never emits ":unknown" for a challenge it accepts', () => {
    // Criterion 5 is satisfied by construction rather than by a guard: every
    // member of the mappable set now resolves or throws, so the sentinel has
    // no producer. An unreachable branch cannot regress a caller; a reachable
    // one turned into an error can.
    for (const [, ch] of everyMappableMethod) {
      expect(fromMppChargeChallenge(ch).network).toMatch(/^[a-z0-9]+:[a-zA-Z0-9-]+$/);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Rejection messages name the actual reason
// ══════════════════════════════════════════════════════════════

describe('unmapped method rejection', () => {
  it('does not describe blockchain methods as processor-based', () => {
    // hedera, usdc and nearintents are specified blockchain Charge methods with
    // real payTo fields. The old catch-all told the reader they "have no
    // payTo/asset exposed", sending them to look for a problem that isn't there.
    for (const method of ['hedera', 'usdc', 'nearintents']) {
      const ch = challenge(method, {
        amount: '1000',
        currency: 'usdc',
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        methodDetails: {},
      });
      expect(() => fromMppChargeChallenge(ch)).toThrow(/blockchain Charge method/);
      expect(() => fromMppChargeChallenge(ch)).not.toThrow(/processor-based/);
    }
  });

  it('still names processor routing for genuine processor methods', () => {
    const ch = challenge('stripe', {
      amount: '5000',
      currency: 'usd',
      methodDetails: { networkId: 'profile_123' },
    });
    expect(() => fromMppChargeChallenge(ch)).toThrow(/processor-based/);
  });
});

// ══════════════════════════════════════════════════════════════
// The MUST-reject clause, enforced in the translator
// ══════════════════════════════════════════════════════════════

describe('expectedNetwork enforcement', () => {
  it('accepts a challenge whose network matches the configured one', () => {
    const req = fromMppChargeChallenge(solana({ network: 'devnet' }), {
      expectedNetwork: 'solana:devnet',
    });
    expect(req.network).toBe('solana:devnet');
  });

  it('rejects a challenge whose cluster does not match the configured one', () => {
    // The spec's MUST, enforced where the lift happens rather than deferred to
    // every downstream caller.
    expect(() =>
      fromMppChargeChallenge(solana({ network: 'devnet' }), { expectedNetwork: 'solana:mainnet' }),
    ).toThrow(/solana:mainnet/);
  });

  it('catches the exact confusion finding 1 describes', () => {
    // A devnet challenge presented to a mainnet-configured client. Before this
    // change both sides read "solana:unknown" and the comparison passed.
    expect(() =>
      fromMppChargeChallenge(solana({}), { expectedNetwork: 'solana:devnet' }),
    ).toThrow(s402Error);
  });

  it('remains opt-in — no expectedNetwork means no comparison', () => {
    expect(fromMppChargeChallenge(solana({ network: 'devnet' })).network).toBe('solana:devnet');
  });

  it('still accepts a bare number as the legacy `now` argument', () => {
    // Back-compat: the second parameter was `now?: number` before this change.
    const now = Date.parse('2099-01-01T00:00:00Z');
    expect(fromMppChargeChallenge(solana({}), now).expiresAt).toBeGreaterThan(now);
  });

  it('accepts now inside the options object', () => {
    const now = Date.parse('2099-01-01T00:00:00Z');
    expect(fromMppChargeChallenge(solana({}), { now }).expiresAt).toBeGreaterThan(now);
  });

  it('applies expiry and network checks together', () => {
    const expired = { ...solana({ network: 'devnet' }), expires: '2020-01-01T00:00:00Z' };
    expect(() => fromMppChargeChallenge(expired, { expectedNetwork: 'solana:devnet' }))
      .toThrow(/expired/);
  });
});
