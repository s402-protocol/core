/**
 * Sui Exact-Scheme Client Implementation
 *
 * Implements s402ClientScheme for the "exact" payment scheme on Sui.
 * Builds a PTB that transfers the requested amount to the payTo address,
 * signs it with the configured keypair, and returns the payload.
 *
 * Security: Sets epoch-based expiration so signed transactions cannot be
 * held and replayed after the current epoch (~24h on mainnet).
 */

import { Transaction } from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiClient } from '@mysten/sui/client';
import type { s402ClientScheme, s402PaymentRequirements, s402PaymentPayload } from 's402';
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
  };
}
