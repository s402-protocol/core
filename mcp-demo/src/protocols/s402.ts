const PLACEHOLDER_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000abc';

export const DEMO_PROVIDER_ADDRESS =
  process.env.SUI_RECEIVER_ADDRESS ?? PLACEHOLDER_ADDRESS;

export const s402PaymentObject = {
  protocol: 's402',
  version: '1',
  scheme: 'prepaid',
  amount: '10000000',
  asset: '0x2::sui::SUI',
  network: 'sui:testnet',
  payTo: DEMO_PROVIDER_ADDRESS,
  schemeParams: {
    ratePerCall: '1000',
    maxCalls: '10000',
    minDeposit: '1000000',
    withdrawalDelayMs: '60000',
    providerPubkey: '0000000000000000000000000000000000000000000000000000000000000abc'
  }
} as const;
