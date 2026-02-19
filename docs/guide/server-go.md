# Accept s402 Payments in Go

s402 is language-agnostic. This example uses Go's `net/http` standard library — no external dependencies. The same pattern works with Gin, Echo, Fiber, or any Go HTTP framework.

## The 30-Second Version

An s402 server does three things:

1. **Return 402** with a `payment-required` header (base64 JSON)
2. **Decode** the `x-payment` header from the client's retry
3. **Verify** the Sui transaction via RPC

~60 lines of Go. No SDK required.

## Full Example (net/http)

```go
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	payTo    = "0xYOUR_ADDRESS_HERE"
	price    = "1000000" // 0.001 SUI in MIST
	suiRPC   = "https://fullnode.testnet.sui.io:443"
)

func encodeB64JSON(v any) string {
	b, _ := json.Marshal(v)
	return base64.StdEncoding.EncodeToString(b)
}

func decodeB64JSON(s string) (map[string]any, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	return m, json.Unmarshal(b, &m)
}

func write402(w http.ResponseWriter) {
	requirements := map[string]any{
		"s402Version": "1",
		"accepts":     []string{"exact"},
		"network":     "sui:testnet",
		"asset":       "0x2::sui::SUI",
		"amount":      price,
		"payTo":       payTo,
		"expiresAt":   time.Now().Add(5 * time.Minute).UnixMilli(),
	}

	w.Header().Set("payment-required", encodeB64JSON(requirements))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(402)
	json.NewEncoder(w).Encode(map[string]string{"error": "Payment Required"})
}

func verifySuiTx(txDigest string) bool {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "sui_getTransactionBlock",
		"params":  []any{txDigest, map[string]bool{"showEffects": true}},
	})

	resp, err := http.Post(suiRPC, "application/json", bytes.NewReader(body))
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	var result struct {
		Result struct {
			Effects struct {
				Status struct {
					Status string `json:"status"`
				} `json:"status"`
			} `json:"effects"`
		} `json:"result"`
	}
	json.Unmarshal(data, &result)
	return result.Result.Effects.Status.Status == "success"
}

func premiumData(w http.ResponseWriter, r *http.Request) {
	paymentHeader := r.Header.Get("x-payment")

	if paymentHeader == "" {
		write402(w)
		return
	}

	// Decode payment payload
	payload, err := decodeB64JSON(paymentHeader)
	if err != nil {
		http.Error(w, `{"error":"Invalid payment header"}`, 400)
		return
	}

	// Extract tx digest from payload
	inner, _ := payload["payload"].(map[string]any)
	txDigest, _ := inner["txDigest"].(string)

	if txDigest == "" || !verifySuiTx(txDigest) {
		http.Error(w, `{"error":"Payment verification failed"}`, 402)
		return
	}

	// Payment verified — serve premium content
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"data":     "This is premium data you paid for!",
		"txDigest": txDigest,
	})
}

func main() {
	http.HandleFunc("/api/premium-data", premiumData)
	fmt.Println("s402 server listening on :3402")
	http.ListenAndServe(":3402", nil)
}
```

## Run It

```bash
go run server.go
```

No dependencies to install. Just `go run`.

## Test It

```bash
# Step 1: Get the 402 response
curl -i http://localhost:3402/api/premium-data
# → 402 with payment-required header

# Step 2: Decode the requirements (pipe through base64 -d)
curl -s http://localhost:3402/api/premium-data -D - -o /dev/null 2>&1 \
  | grep payment-required \
  | cut -d' ' -f2 \
  | base64 -d \
  | python3 -m json.tool
```

The client-side payment flow (building the Sui transaction, signing, retrying) is handled by [`@sweefi/cli`](https://www.npmjs.com/package/@sweefi/cli) or any s402 client.

## Production Hardening

The example above is minimal. For production, add:

- **Amount verification**: Inspect `balanceChanges` in the RPC response to confirm the correct amount was sent to your address
- **Replay protection**: Store processed `txDigest` values in a set/database
- **Expiry enforcement**: Reject payments where the requirements have expired
- **HTTPS**: Required — payment headers are base64, not encrypted
- **Concurrent safety**: Use `sync.Map` or similar for the replay protection set

## Key Takeaway

Go's standard library is enough to accept s402 payments. No SDK, no dependencies, no framework required. The entire server-side integration is: decode base64, parse JSON, POST to Sui RPC.
