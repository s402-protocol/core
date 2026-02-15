import { describe, it, expect } from 'vitest';
import {
  s402Error,
  s402ErrorCode,
  createS402Error,
} from '../src/index.js';

describe('s402 errors', () => {
  it('s402Error has correct properties', () => {
    const err = new s402Error('INSUFFICIENT_BALANCE', 'Not enough SUI');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('s402Error');
    expect(err.code).toBe('INSUFFICIENT_BALANCE');
    expect(err.message).toBe('Not enough SUI');
    expect(err.retryable).toBe(false);
    expect(err.suggestedAction).toContain('Top up');
  });

  it('s402Error uses code as default message', () => {
    const err = new s402Error('FINALITY_TIMEOUT');
    expect(err.message).toBe('FINALITY_TIMEOUT');
    expect(err.retryable).toBe(true);
  });

  it('toJSON serializes correctly', () => {
    const err = new s402Error('MANDATE_EXPIRED', 'Mandate has expired');
    const json = err.toJSON();

    expect(json.code).toBe('MANDATE_EXPIRED');
    expect(json.message).toBe('Mandate has expired');
    expect(json.retryable).toBe(false);
    expect(json.suggestedAction).toContain('new mandate');
  });

  it('createS402Error returns info object', () => {
    const info = createS402Error('FACILITATOR_UNAVAILABLE');

    expect(info.code).toBe('FACILITATOR_UNAVAILABLE');
    expect(info.retryable).toBe(true);
    expect(info.suggestedAction).toContain('direct settlement');
  });

  it('all error codes have recovery hints', () => {
    for (const code of Object.values(s402ErrorCode)) {
      const info = createS402Error(code);
      expect(info.retryable).toBeDefined();
      expect(info.suggestedAction).toBeTruthy();
    }
  });

  it('retryable codes are correctly marked', () => {
    const retryable = ['STREAM_DEPLETED', 'SEAL_DECRYPTION_FAILED', 'FINALITY_TIMEOUT', 'FACILITATOR_UNAVAILABLE', 'REQUIREMENTS_EXPIRED'];
    const nonRetryable = ['INSUFFICIENT_BALANCE', 'MANDATE_EXPIRED', 'MANDATE_LIMIT_EXCEEDED', 'ESCROW_DEADLINE_PASSED', 'INVALID_PAYLOAD', 'SCHEME_NOT_SUPPORTED', 'NETWORK_MISMATCH', 'SIGNATURE_INVALID', 'VERIFICATION_FAILED'];

    for (const code of retryable) {
      expect(createS402Error(code as any).retryable).toBe(true);
    }
    for (const code of nonRetryable) {
      expect(createS402Error(code as any).retryable).toBe(false);
    }
  });
});
