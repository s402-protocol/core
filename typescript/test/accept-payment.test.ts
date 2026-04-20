import { describe, it, expect } from 'vitest';
import {
  parseAcceptPayment,
  formatAcceptPayment,
  selectBestScheme,
  type AcceptPaymentEntry,
} from '../src/accept-payment.js';

describe('parseAcceptPayment — happy path', () => {
  it('parses a single scheme with default q=1', () => {
    expect(parseAcceptPayment('s402/exact')).toEqual([{ scheme: 's402/exact', q: 1 }]);
  });

  it('parses multiple schemes and sorts by q descending', () => {
    const result = parseAcceptPayment('tempo/charge;q=0.5, s402/prepaid, s402/exact;q=0.8');
    expect(result).toEqual([
      { scheme: 's402/prepaid', q: 1 },
      { scheme: 's402/exact', q: 0.8 },
      { scheme: 'tempo/charge', q: 0.5 },
    ]);
  });

  it('preserves input order for equal q-values (stable sort)', () => {
    const result = parseAcceptPayment('s402/exact, tempo/charge, stripe/card');
    expect(result.map((e) => e.scheme)).toEqual([
      's402/exact',
      'tempo/charge',
      'stripe/card',
    ]);
  });

  it('lowercases scheme tokens', () => {
    expect(parseAcceptPayment('S402/Exact')).toEqual([{ scheme: 's402/exact', q: 1 }]);
  });

  it('tolerates surrounding whitespace', () => {
    const result = parseAcceptPayment('  s402/exact ;  q=0.5 ,  s402/prepaid  ');
    expect(result).toEqual([
      { scheme: 's402/prepaid', q: 1 },
      { scheme: 's402/exact', q: 0.5 },
    ]);
  });

  it('accepts bare "0" and "1" for q-value', () => {
    expect(parseAcceptPayment('s402/exact;q=1')).toEqual([{ scheme: 's402/exact', q: 1 }]);
    expect(parseAcceptPayment('s402/exact;q=0')).toEqual([{ scheme: 's402/exact', q: 0 }]);
  });

  it('deduplicates schemes, keeping the highest q-value', () => {
    const result = parseAcceptPayment('s402/exact;q=0.3, s402/exact;q=0.9');
    expect(result).toEqual([{ scheme: 's402/exact', q: 0.9 }]);
  });
});

describe('parseAcceptPayment — empty / null / malformed', () => {
  it('returns [] for null/undefined/empty', () => {
    expect(parseAcceptPayment(null)).toEqual([]);
    expect(parseAcceptPayment(undefined)).toEqual([]);
    expect(parseAcceptPayment('')).toEqual([]);
    expect(parseAcceptPayment('   ')).toEqual([]);
  });

  it('skips entries with invalid q-values', () => {
    const result = parseAcceptPayment('s402/exact;q=1.5, s402/prepaid');
    expect(result).toEqual([{ scheme: 's402/prepaid', q: 1 }]);
  });

  it('skips entries with malformed param (missing =)', () => {
    const result = parseAcceptPayment('s402/exact;foo, s402/prepaid');
    expect(result).toEqual([{ scheme: 's402/prepaid', q: 1 }]);
  });

  it('rejects scheme tokens containing invalid characters', () => {
    expect(parseAcceptPayment('s402 exact')).toEqual([]);
    expect(parseAcceptPayment('s402"exact"')).toEqual([]);
    expect(parseAcceptPayment('=s402')).toEqual([]);
  });

  it('ignores trailing commas and empty segments', () => {
    expect(parseAcceptPayment('s402/exact,,s402/prepaid,')).toEqual([
      { scheme: 's402/exact', q: 1 },
      { scheme: 's402/prepaid', q: 1 },
    ]);
  });

  it('ignores unknown parameters (key other than q)', () => {
    const result = parseAcceptPayment('s402/exact;version=1;q=0.7');
    expect(result).toEqual([{ scheme: 's402/exact', q: 0.7 }]);
  });

  it('does not throw on pathological input', () => {
    expect(() => parseAcceptPayment(';;;,,,===')).not.toThrow();
    expect(parseAcceptPayment(';;;,,,===')).toEqual([]);
  });
});

describe('formatAcceptPayment', () => {
  it('omits q=1 and emits others with minimal decimals', () => {
    const entries: AcceptPaymentEntry[] = [
      { scheme: 's402/prepaid', q: 1 },
      { scheme: 'tempo/charge', q: 0.5 },
      { scheme: 's402/exact', q: 0.25 },
    ];
    expect(formatAcceptPayment(entries)).toBe(
      's402/prepaid, tempo/charge;q=0.5, s402/exact;q=0.25',
    );
  });

  it('round-trips through parse without drift', () => {
    const original = 's402/prepaid, s402/exact;q=0.8, tempo/charge;q=0.5';
    const round = formatAcceptPayment(parseAcceptPayment(original));
    expect(round).toBe(original);
  });

  it('handles q=0 entries', () => {
    expect(formatAcceptPayment([{ scheme: 's402/exact', q: 0 }])).toBe('s402/exact;q=0');
  });

  it('filters invalid entries', () => {
    const result = formatAcceptPayment([
      { scheme: 's402/exact', q: 1 },
      { scheme: 'bad token', q: 0.5 },
      { scheme: 's402/prepaid', q: 1.5 },
    ]);
    expect(result).toBe('s402/exact');
  });

  it('returns empty string for empty input', () => {
    expect(formatAcceptPayment([])).toBe('');
  });
});

describe('selectBestScheme', () => {
  const supported = ['s402/exact', 's402/prepaid', 'tempo/charge'];

  it('picks highest-q match from preferred', () => {
    const preferred = parseAcceptPayment('s402/prepaid, s402/exact;q=0.5');
    expect(selectBestScheme(preferred, supported)).toBe('s402/prepaid');
  });

  it('falls back to server default when preferred is empty', () => {
    expect(selectBestScheme([], supported)).toBe('s402/exact');
  });

  it('returns null when no overlap', () => {
    const preferred = parseAcceptPayment('stripe/lightning, solana/exact');
    expect(selectBestScheme(preferred, supported)).toBeNull();
  });

  it('skips entries with q=0 (explicit rejection)', () => {
    const preferred = parseAcceptPayment('s402/exact;q=0, s402/prepaid;q=0.5');
    expect(selectBestScheme(preferred, supported)).toBe('s402/prepaid');
  });

  it('returns null when every preferred entry is q=0', () => {
    const preferred = parseAcceptPayment('s402/exact;q=0, s402/prepaid;q=0');
    expect(selectBestScheme(preferred, supported)).toBeNull();
  });

  it('preserves supported-array casing in returned value', () => {
    const preferred = parseAcceptPayment('S402/EXACT');
    expect(selectBestScheme(preferred, ['s402/exact'])).toBe('s402/exact');
  });

  it('returns null for empty supported list', () => {
    expect(selectBestScheme([{ scheme: 's402/exact', q: 1 }], [])).toBeNull();
  });

  it('respects server preference order in ties within preferred', () => {
    // Both s402/prepaid and s402/exact at q=1, s402/prepaid listed first.
    const preferred = parseAcceptPayment('s402/prepaid, s402/exact');
    expect(selectBestScheme(preferred, supported)).toBe('s402/prepaid');
  });
});

describe('integration — coexistence scenario from migration guide', () => {
  it('client prefers s402, server falls through MPP-only supported list', () => {
    const preferred = parseAcceptPayment('s402/prepaid, s402/exact;q=0.9, tempo/charge;q=0.3');
    const mppOnlyServer = ['tempo/charge', 'stripe/card'];
    expect(selectBestScheme(preferred, mppOnlyServer)).toBe('tempo/charge');
  });

  it('MPP-only client rejects s402-only server', () => {
    const preferred = parseAcceptPayment('tempo/charge, stripe/card');
    const s402OnlyServer = ['s402/exact', 's402/prepaid'];
    expect(selectBestScheme(preferred, s402OnlyServer)).toBeNull();
  });

  it('both-speak client and both-speak server converge on highest-q match', () => {
    const preferred = parseAcceptPayment(
      's402/prepaid;q=1, tempo/charge;q=0.8, s402/exact;q=0.5',
    );
    const server = ['s402/exact', 's402/prepaid', 'tempo/charge', 'stripe/card'];
    expect(selectBestScheme(preferred, server)).toBe('s402/prepaid');
  });
});
