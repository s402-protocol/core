/**
 * Sui Exact-Scheme Client Implementation
 *
 * Implements s402ClientScheme for the "exact" payment scheme on Sui.
 * Builds a PTB that transfers the requested amount to the payTo address,
 * signs it with the configured keypair, and returns the payload.
 *
 * Security:
 * - Sets epoch-based expiration so signed transactions cannot be
 *   held and replayed after the current epoch (~24h on mainnet).
 * - `verifySettlement` performs a local, offline check that the facilitator's
 *   returned tx digest is causally bound to the exact signed bytes we sent.
 *   This closes the April 2026 council's "causal-binding hole" (ADR-001 D1)
 *   without any RPC roundtrip — see `spec/allium/digest-assertion.allium`.
 */

import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromB64 } from '@mysten/sui/utils';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiClient } from '@mysten/sui/client';
import type {
  s402ClientScheme,
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
  s402SettlementVerification,
} from 's402';
import { S402_VERSION } from 's402';

/**
 * Create a Sui exact-scheme client that builds and signs SUI transfer PTBs.
 *
 * @param keypair - Ed25519 keypair for signing transactions
 * @param client - SuiClient for gas estimation and transaction building
 */
export function createSuiExactScheme(
  keypair: Ed25519Keypair,
  client: SuiClient,
): s402ClientScheme {
  return {
    scheme: 'exact',

    async createPayment(
      requirements: s402PaymentRequirements,
    ): Promise<s402PaymentPayload> {
      const tx = new Transaction();

      // Split the requested amount from gas coin and transfer to payTo
      const [coin] = tx.splitCoins(tx.gas, [BigInt(requirements.amount)]);
      tx.transferObjects([coin], requirements.payTo);

      // Epoch expiration: transaction is only valid for current + next epoch.
      // Prevents a malicious server from holding the signed tx and replaying later.
      const systemState = await client.getLatestSuiSystemState();
      tx.setExpiration({ Epoch: Number(systemState.epoch) + 2 });

      // Sign the transaction (does NOT broadcast — facilitator does that)
      const { bytes, signature } = await tx.sign({ client, signer: keypair });

      return {
        s402Version: S402_VERSION,
        scheme: 'exact',
        payload: {
          transaction: bytes,     // base64-encoded transaction bytes
          signature: signature,   // base64-encoded Ed25519 signature
        },
      };
    },

    /**
     * Causal-binding check for facilitator settlement receipts (ADR-001 D1).
     *
     * The client already holds the exact signed bytes it sent. Sui's tx digest
     * is a deterministic blake2b hash of those bytes (via the BCS-encoded
     * TransactionData), so the correct digest can be recomputed locally
     * without any RPC call. If the facilitator returns a different digest,
     * it either (a) broadcast a different transaction than the one we signed
     * (impossible unless the signature is forgeable — Ed25519 says no), or
     * (b) is lying about what it broadcast. Either way we refuse to treat
     * the payment as settled.
     *
     * This is a pure function — no network, no chain state, no client needed.
     */
    verifySettlement(
      payload: s402PaymentPayload,
      settleResponse: s402SettleResponse,
    ): s402SettlementVerification {
      if (payload.scheme !== 'exact') {
        return {
          verified: false,
          expectedDigest: '',
          actualDigest: settleResponse.txDigest ?? null,
          reason: `verifySettlement called with non-exact scheme "${payload.scheme}"`,
        };
      }

      // Recompute the digest from OUR signed bytes. This is the commitment
      // the client made to the facilitator — any substitution breaks it.
      const signedBytes = fromB64(payload.payload.transaction);
      const expectedDigest = TransactionDataBuilder.getDigestFromBytes(signedBytes);

      const actualDigest = settleResponse.txDigest ?? null;
      if (actualDigest == null) {
        return {
          verified: false,
          expectedDigest,
          actualDigest: null,
          reason: 'SettleResponse did not include a txDigest — cannot verify',
        };
      }

      if (actualDigest !== expectedDigest) {
        return {
          verified: false,
          expectedDigest,
          actualDigest,
          reason:
            `Digest mismatch: facilitator returned ${actualDigest} but the ` +
            `signed payload commits to ${expectedDigest}. The facilitator ` +
            `broadcast a different transaction, or is lying about what it ` +
            `broadcast. Treat this payment as non-settled and do NOT retry.`,
        };
      }

      return { verified: true, expectedDigest, actualDigest };
    },
  };
}
