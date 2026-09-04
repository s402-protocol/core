import { toX402V2Requirements } from 's402/compat/x402';
import type { s402PaymentRequirements } from 's402/types';

const x402NativeShape: s402PaymentRequirements = {
  // Wire v2: one scheme per requirement, named by `scheme`. The list of scheme
  // NAMES is gone — offering several is what the 402's `accepts[]` is for.
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000',
  payTo: '0x0000000000000000000000000000000000000abc'
};

const x402V2 = toX402V2Requirements(x402NativeShape, { maxTimeoutSeconds: 60 });

export const x402PaymentObject = {
  protocol: 'x402',
  version: '2',
  ...x402V2
};
