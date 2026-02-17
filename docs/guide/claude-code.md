# Use s402 in Claude Code

Add SweePay as an MCP server and your Claude Code agent can check balances, make payments, handle 402 responses, create escrows, and manage streaming payments — all from natural language.

## Setup (One Command)

```bash
claude mcp add --transport stdio \
  --env SUI_PRIVATE_KEY="your-base64-ed25519-key" \
  --env SUI_NETWORK="testnet" \
  sweepay-mcp \
  -- npx -y @sweepay/mcp
```

Or add to your project's `.mcp.json` (shared with your team):

```json
{
  "mcpServers": {
    "sweepay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sweepay/mcp"],
      "env": {
        "SUI_PRIVATE_KEY": "${SUI_PRIVATE_KEY}",
        "SUI_NETWORK": "testnet"
      }
    }
  }
}
```

Set your key in the environment (never hardcode it):

```bash
export SUI_PRIVATE_KEY="$(sui keytool export --key-identity default --json | jq -r '.exportedPrivateKey')"
```

## What You Get

19 tools available to Claude Code:

| Category | Tools |
|----------|-------|
| **Read-only** | `check_balance`, `supported_tokens`, `get_receipt`, `check_payment` |
| **Payments** | `pay`, `pay_and_prove`, `create_invoice`, `pay_invoice` |
| **Streaming** | `start_stream`, `start_stream_with_timeout`, `stop_stream`, `recipient_close_stream` |
| **Escrow** | `create_escrow`, `release_escrow`, `refund_escrow`, `dispute_escrow` |
| **Admin** | `protocol_status`, `pause_protocol`, `unpause_protocol`, `burn_admin_cap` |

Read-only tools work without a private key. Transaction tools require `SUI_PRIVATE_KEY`.

## Example Prompts

Once connected, just talk to Claude naturally:

```
> "What's my SUI balance on testnet?"
→ Calls check_balance, returns formatted balance

> "Send 0.5 SUI to 0x7a2f...1f2a with memo 'API access'"
→ Calls pay, signs tx, returns digest + explorer link

> "Create an escrow of 10 USDC for 0x456...abc"
→ Calls create_escrow, locks funds on-chain

> "Start a streaming payment of 1 SUI/day to 0x789...def"
→ Calls start_stream, creates stream object

> "Check if tx digest 8Kj2x... was a successful payment"
→ Calls check_payment, verifies on-chain
```

## Handling HTTP 402 APIs

When your agent encounters an s402-gated API:

```
> "Fetch data from https://api.example.com/premium"
  → Agent gets HTTP 402 with payment requirements
  → Agent reads the s402 headers (amount, recipient, scheme)
  → Agent calls sweepay_pay to settle on-chain
  → Agent retries the request with payment proof
  → Agent returns the premium data
```

The agent handles the entire 402 → pay → retry flow autonomously.

## Read-Only Mode

If you don't set `SUI_PRIVATE_KEY`, the MCP server starts in read-only mode. You can still:

- Check any address's balance
- Look up payment receipts
- Verify transactions
- List supported tokens

Useful for monitoring without transaction risk.

## Troubleshooting

**"MCP server not found"** — Run `claude mcp list` to verify it's registered. Check that `npx @sweepay/mcp` works standalone.

**"Transaction failed"** — Ensure your wallet has enough SUI for gas (~0.01 SUI minimum). Get testnet SUI at https://faucet.sui.io.

**"Invalid private key"** — The key must be base64-encoded Ed25519. Export with:
```bash
sui keytool export --key-identity <alias> --json | jq -r '.exportedPrivateKey'
```

**Switching networks** — Change `SUI_NETWORK` to `mainnet`, `testnet`, or `devnet`. Restart Claude Code after changing MCP env vars.
