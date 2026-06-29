# s402 MCP Demo — SEP-2007 Reference Implementation

A minimal Sui-native MCP server that advertises **three coexisting payment protocols** (x402, s402, stripe-mpp) inside a single `payment[]` envelope. Built as a reference implementation for [MCP SEP-2007](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2007).

## The headline artifact

The `tools/list` response advertises three payment options per tool:

```jsonc
{
  "tools": [{
    "name": "summarize",
    "description": "Summarize a document to a single sentence. Payment-gated.",
    "payment": [
      {
        "protocol": "x402",
        "version": "2",
        "scheme": "exact",
        "network": "eip155:8453",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "10000",
        "payTo": "0x0000000000000000000000000000000000000abc",
        "maxTimeoutSeconds": 60,
        "extra": {}
      },
      {
        "protocol": "s402",
        "version": "1",
        "scheme": "prepaid",
        "amount": "10000000",
        "asset": "0x2::sui::SUI",
        "network": "sui:testnet",
        "payTo": "0x0000000000000000000000000000000000000000000000000000000000000abc",
        "schemeParams": {
          "ratePerCall": "1000",
          "maxCalls": "10000",
          "minDeposit": "1000000",
          "withdrawalDelayMs": "60000",
          "providerPubkey": "0000000000000000000000000000000000000000000000000000000000000abc"
        }
      },
      {
        "protocol": "stripe-mpp",
        "version": "0.1",
        "id": "s402-demo-stripe-charge-001",
        "realm": "s402-mcp-demo",
        "method": "stripe",
        "intent": "charge",
        "amount": "1000",
        "currency": "USD",
        "description": "Demo payment-gated tool",
        "methodDetails": { "intentId": "pi_demo_0000000000000000000" }
      }
    ]
  }]
}
```

## Why this demo is small

Look at the `package.json`. Four runtime dependencies:

```json
"dependencies": {
  "s402": "workspace:*",
  "hono": "^4.6.0",
  "@hono/node-server": "^1.13.0",
  "@mysten/sui": "^1.18.0"
}
```

**No `@coinbase/x402` SDK. No Stripe SDK.** The s402 wire-format library natively emits both x402 V2 PaymentRequirements (via `s402/compat/x402`'s `toX402V2Requirements()`) AND MPP-shaped charge challenges (via `s402/compat/mpp`'s `toMppChargeChallenge()`). The x402 entry matches upstream `@x402/core/types/payments.ts` HEAD: slimmer V2 shape with required `extra: {}`, no per-requirement `x402Version`, no `maxAmountRequired` alias. The Stripe MPP entry's `request` field is real base64url-encoded JCS — decode it and you get the canonical MPP Charge Request JSON. Both write paths are roundtrip-stable against the read-path inverses (`fromX402Envelope`, `decodeMppChargeRequest`). The architectural argument — *s402 is a superset by chain-feature construction* — is visible in the import list, not pitched in prose.

## Quick start

This demo is a pnpm workspace package inside the `s402-protocol/core` monorepo. Run from the repo root:

```bash
pnpm install
pnpm --filter s402-mcp-demo dev:server   # in one terminal
pnpm --filter s402-mcp-demo dev:agent    # in another
```

Expected output (envelope-only mode, default):

```
1. Calling tools/list
   Server advertises 3 payment protocols: x402, s402, stripe-mpp

2. Calling tools/call without payment
   Got -32402 Payment Required with 3 options

3. Choosing s402 protocol, settling on Sui
   (envelope-only mode — skipping real Sui transfer)

4. Retrying tools/call with payment proof
   Tool result: The protocol is the platform...
```

## Optional: real Sui testnet settlement

By default, the demo runs in **envelope-only** mode (no on-chain transactions). To exercise real Sui testnet settlement:

1. Generate or import a Sui testnet wallet:
   ```bash
   sui client new-address ed25519
   ```
2. Fund it via the [Sui testnet faucet](https://docs.sui.io/guides/developer/getting-started/get-coins).
3. Run with real settlement enabled:
   ```bash
   SUI_REAL_SETTLEMENT=1 \
   SUI_TESTNET_MNEMONIC="<your 12-word mnemonic>" \
   pnpm --filter s402-mcp-demo dev:agent
   ```

The server (which must also be run with `SUI_REAL_SETTLEMENT=1`) verifies the on-chain settlement via `SuiClient.getTransactionBlock` and checks the balance change credits the demo provider address before executing the tool.

## What this demo proves

- **The `payment[]` envelope is genuinely multi-rail.** Three concrete protocol objects coexist in one tool definition.
- **s402 is wire-compatible with x402 today.** No bridge, no adapter — the s402 library natively speaks x402's V2 wire format.
- **Sui-native settlement is a one-dependency proposition.** `@mysten/sui` plus the s402 library is everything needed for end-to-end paid agent tooling.

## What this demo does NOT do

- **Production-grade authentication.** Demo accepts any `x-s402-tx-digest` header in envelope-only mode. Production servers use the full s402 facilitator flow (see `s402/typescript/src/facilitator.ts`).
- **Real Stripe MPP settlement.** Demo emits a wire-compatible Stripe protocol object but does not integrate with the real Stripe API. Real Stripe MPP requires a merchant account; the envelope shape is what matters for the SEP.
- **Full MCP protocol compliance.** Demo implements `tools/list` and `tools/call` only. `initialize`, `prompts/list`, etc. are out of scope for the payment envelope proof.
- **A real receiver address.** `DEMO_PROVIDER_ADDRESS` defaults to a placeholder (`0x...abc`). Set `SUI_RECEIVER_ADDRESS=0x<your_real_testnet_wallet>` to route real-settlement-mode transfers to a wallet you control.
- **Real x402 or stripe-mpp settlement verification.** Demo returns a `501` JSON-RPC error when a client tries to pay via x402 or stripe-mpp — those protocol objects are for envelope-shape demonstration only.

## Open follow-ups (v0.1 polish)

- **Dockerfile.** Removed for v0 because `workspace:*` requires monorepo build context. Add back with multi-stage build from monorepo root.
- **`toMPP()` write helper upstream to `s402/compat/mpp`.** The MPP protocol object is currently constructed manually because the compat module is read-path-only. Filed in `s402-project/knowledge/protocol-design.md` TODO.
- **Agent protocol selection.** Currently hardcoded to s402. Could iterate to make the agent dynamically choose based on the payment[] array contents.

## File layout

```
mcp-demo/
├── package.json           # 4 deps: s402, hono, @hono/node-server, @mysten/sui
├── tsconfig.json
└── src/
    ├── server.ts          # Hono MCP server, ~80 lines
    ├── agent.ts           # client + Sui transaction construction, ~70 lines
    ├── tools/
    │   └── summarize.ts   # the payment-gated demo tool
    └── protocols/
        ├── s402.ts        # native S402 payment object
        ├── x402.ts        # x402 V2 PaymentRequirements via s402/compat/x402 toX402V2Requirements()
        └── stripe-mpp.ts  # real MPP wire format via s402/compat/mpp toMppChargeChallenge()
```

## Related

- s402 spec: `../docs/`
- s402 schemes (exact, upto, prepaid, stream, escrow, unlock): `../docs/schemes/`
- s402 wire format types: `../typescript/src/types.ts`
- MCP SEP-2007 PR: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2007
