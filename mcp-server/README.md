# s402-mcp

[![npm version](https://img.shields.io/npm/v/s402-mcp)](https://www.npmjs.com/package/s402-mcp)
[![license](https://img.shields.io/npm/l/s402-mcp)](https://github.com/s402-protocol/core/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/s402-mcp)](https://nodejs.org)

MCP server that lets AI agents pay for APIs using the [s402 protocol](https://s402-protocol.org) on Sui.

```
npx s402-mcp
```

## What it does

When an AI agent (Claude Code, Cursor, etc.) encounters an API that requires payment, this MCP server handles the entire HTTP 402 negotiation automatically:

1. Agent calls `s402_fetch(url)` instead of regular fetch
2. If the server returns 402 Payment Required, the tool reads the price
3. Validates the request against security checks (cap, budget, expiry, asset, network)
4. Builds and signs a Sui transaction for the requested amount
5. Retries the request with the payment attached
6. Returns the API response + transaction receipt

Compatible with both **s402** and **x402** (Coinbase) payment protocols.

## Setup

### 1. Get a Sui keypair

```bash
# Generate a new keypair
sui keytool generate ed25519

# Or export an existing one
sui keytool export --key-identity <alias>
```

### 2. Fund it

```bash
# Testnet faucet
sui client faucet --address <your-address> --network testnet

# Or transfer SUI from another wallet
```

**Important**: Use a dedicated hot wallet with minimal funds. Do not use your main wallet.

### 3. Configure Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "s402": {
      "command": "npx",
      "args": ["s402-mcp"],
      "env": {
        "S402_PRIVATE_KEY": "suiprivkey1...",
        "S402_NETWORK": "sui:testnet",
        "S402_MAX_PAYMENT": "10000000",
        "S402_SESSION_BUDGET": "100000000"
      }
    }
  }
}
```

Or for project-level config, add to `.claude/settings.json` in your repo.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `S402_PRIVATE_KEY` | Yes | — | Sui Ed25519 private key (`suiprivkey1...`, base64, or hex) |
| `S402_NETWORK` | No | `sui:mainnet` | Network (`sui:mainnet`, `sui:testnet`, `sui:devnet`) |
| `S402_MAX_PAYMENT` | No | `10000000` | Per-request cap in MIST (0.01 SUI). Cannot be overridden upward by tool calls. |
| `S402_SESSION_BUDGET` | No | `100000000` | Cumulative session cap in MIST (0.1 SUI). Resets on server restart. |
| `S402_TIMEOUT_MS` | No | `30000` | HTTP request timeout in milliseconds |

## Tools

### `s402_fetch`

Fetch a URL with automatic payment handling.

```
s402_fetch({
  url: "https://api.example.com/data",
  method: "GET",
  maxPayment: "5000000"  // Optional: lower the cap for this request (cannot exceed server max)
})
```

Returns the API response body, HTTP status, payment receipt, and session spend tracking.

### `s402_check_price`

Check what a URL costs without paying.

```
s402_check_price({ url: "https://api.example.com/data" })
```

Returns the price, accepted schemes, network, and a `canPay` boolean summarizing all checks.

### `s402_balance`

Check your payment wallet balance and session usage.

```
s402_balance()
```

Returns address, SUI balance, session spend, and remaining budget.

## Security Model

This server handles real cryptocurrency. It was hardened through a 3-wave security audit:

### Spending controls
- **Per-request cap** (`S402_MAX_PAYMENT`): No single payment can exceed this limit. Tool callers can lower it per-request but never exceed it.
- **Session budget** (`S402_SESSION_BUDGET`): Cumulative spending cap across all tool calls. Prevents draining via many small payments. Resets on server restart.

### Request safety
- **SSRF protection**: Blocks requests to private IPs, cloud metadata endpoints (169.254.169.254), loopback, and link-local addresses.
- **Redirect protection**: Paid re-requests reject redirects to prevent signed payment headers from leaking to third parties.
- **Header sanitization**: Blocks injection of sensitive headers (`Host`, `x-payment`, `Transfer-Encoding`, etc.) via tool parameters.
- **Fetch timeout**: Configurable timeout prevents slow-server denial of service (default: 30s).
- **Response size limit**: Bodies are streamed with a 10 MB cap to prevent memory exhaustion.

### Payment validation
- **Expiry enforcement** (S1 invariant): Rejects expired payment requirements before signing.
- **Asset validation**: Only SUI native coin payments are supported; rejects non-SUI asset requests.
- **Amount validation**: Rejects negative, zero, and u64-overflow amounts.
- **Network check**: Verifies the server's required network matches configuration.
- **Double-402 detection**: If the paid re-request returns 402, reports failure and warns against retry.
- **Transaction expiry**: Signed transactions include epoch-based expiration to limit replay windows.

### Key safety
- The private key is loaded from environment variables (standard MCP pattern) and never appears in tool responses or error messages.
- Use a **dedicated hot wallet** with minimal funds. Do not use your main wallet or seed phrase.
- There is no key rotation mechanism — restart the server with a new key to rotate.

### Known limitations
- **DNS rebinding**: URL validation checks hostname strings but cannot prevent DNS rebinding attacks where a hostname resolves to a private IP after validation. Deploy behind a DNS-aware proxy for full protection.
- **Epoch-based expiry**: Sui epochs are ~24h on mainnet. Signed transactions are valid for up to 2 epochs. For tighter guarantees, the facilitator protocol should include a nonce.
- **Single coin type**: Only SUI gas coin payments. USDC and other coin types require additional scheme implementations.

## License

Apache-2.0
