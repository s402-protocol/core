import { toMppChargeRequest } from 's402/compat/mpp';

const mppRequest = toMppChargeRequest({
  method: 'stripe',
  amount: '1000',
  currency: 'USD',
  methodDetails: { intentId: 'pi_demo_0000000000000000000' },
  description: 'Demo payment-gated tool'
});

export const stripeMppPaymentObject = {
  protocol: 'stripe-mpp',
  version: '0.1',
  id: 's402-demo-stripe-charge-001',
  realm: 's402-mcp-demo',
  method: 'stripe',
  intent: 'charge',
  ...mppRequest
};
