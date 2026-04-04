/**
 * s402 MCP Tools
 *
 * Three tools that give AI agents the ability to pay for APIs:
 *
 *   s402_fetch       — Fetch a URL, automatically handle 402 payment negotiation
 *   s402_check_price — Peek at what a URL costs without paying
 *   s402_balance     — Check wallet balance on Sui
 *
 * Security hardening (from 3-wave audit):
 *   - SSRF protection: blocks private/internal IPs, cloud metadata endpoints
 *   - Session spending cap: cumulative limit across all requests
 *   - Per-request cap clamped to server max (cannot be overridden upward)
 *   - expiresAt enforcement: rejects expired payment requirements
 *   - Asset validation: only SUI payments supported (rejects non-SUI assets)
 *   - Amount validation: positive, u64-bounded
 *   - Double-402 detection: detects failed payment re-requests
 *   - Redirect protection: paid re-request blocks redirects
 *   - Header sanitization: blocks sensitive header injection
 *   - Fetch timeout: configurable, default 30s
 *   - Response body limit: 10 MB max
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  s402Client,
  extractRequirementsFromResponse,
  encodePaymentPayload,
  decodeSettleResponse,
  detectProtocol,
  isValidU64Amount,
  S402_HEADERS,
} from 's402';
import { normalizeRequirements } from 's402/compat';
import type { s402PaymentRequirements } from 's402';
import type { S402Config } from './config.js';
import { mistToSui, SUI_COIN_TYPE, MAX_RESPONSE_BYTES } from './config.js';
import { createSuiExactScheme } from './sui-exact.js';

// ═══════════════════════════════════════════════════════════
// Security: SSRF protection
// ═══════════════════════════════════════════════════════════

const BLOCKED_HOSTNAME_PATTERNS = [
  /^127\./,                         // IPv4 loopback
  /^10\./,                          // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./,    // RFC 1918 Class B
  /^192\.168\./,                    // RFC 1918 Class C
  /^169\.254\./,                    // Link-local / cloud metadata
  /^0\./,                           // Current network
  /^localhost$/i,                   // Loopback hostname
  /^\[?::1\]?$/,                   // IPv6 loopback
  /^metadata\.google\.internal$/i,  // GCP metadata
  /^\[?fe80:/i,                    // IPv6 link-local
  /^\[?fd[0-9a-f]{2}:/i,          // IPv6 ULA
  /^\[?fc[0-9a-f]{2}:/i,          // IPv6 ULA
  /^\[?::ffff:/i,                  // IPv4-mapped IPv6 (bypass vector)
  /^\[?::\]?$/,                    // IPv6 unspecified (all-zeros)
];

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `Blocked URL scheme "${parsed.protocol}". Only http: and https: are allowed.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error('Blocked URL: embedded credentials are not allowed.');
  }

  const hostname = parsed.hostname;
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(
        `Blocked URL: "${hostname}" resolves to a private/internal address.`,
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Security: Header sanitization
// ═══════════════════════════════════════════════════════════

const BLOCKED_HEADERS = new Set([
  'host',
  'x-payment',
  'payment-required',
  'payment-response',
  'transfer-encoding',
  'content-length',
  'connection',
  'upgrade',
  'te',
]);

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
      clean[key] = value;
    }
  }
  return clean;
}

// ═══════════════════════════════════════════════════════════
// Security: Response body size limiter
// ═══════════════════════════════════════════════════════════

async function readBody(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  // Fast-reject if Content-Length exceeds limit
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(
      `Response too large: Content-Length ${contentLength} exceeds ${maxBytes} byte limit.`,
    );
  }

  // Stream with size enforcement
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(
          `Response body exceeds ${maxBytes} byte limit (read ${totalBytes} bytes).`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

// ═══════════════════════════════════════════════════════════
// Protocol: Extract requirements (s402 + x402 compat)
// ═══════════════════════════════════════════════════════════

/** Unicode-safe base64 decode (matches s402 SDK's internal fromBase64) */
function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function extractRequirements(
  response: Response,
): s402PaymentRequirements | null {
  // Try native s402 first (uses SDK's full validation pipeline)
  const s402Reqs = extractRequirementsFromResponse(response);
  if (s402Reqs) return s402Reqs;

  // Try x402 compat — detect, decode, normalize
  const header = response.headers.get(S402_HEADERS.PAYMENT_REQUIRED);
  if (!header) return null;

  try {
    const protocol = detectProtocol(response.headers);
    if (protocol === 'x402') {
      const raw = JSON.parse(fromBase64(header));
      return normalizeRequirements(raw);
    }
  } catch {
    // Fall through
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// Tool registration
// ═══════════════════════════════════════════════════════════

export function registerTools(server: McpServer, config: S402Config): void {
  // Wire up s402 client with Sui exact scheme
  const paymentClient = new s402Client();
  paymentClient.register(
    config.network,
    createSuiExactScheme(config.keypair, config.client),
  );

  // Session spend tracking (cumulative across all tool calls)
  let sessionSpend = 0n;

  /** Build a JSON text response for MCP */
  function jsonResponse(data: unknown, isError = false) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      ...(isError ? { isError: true } : {}),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Tool 1: s402_fetch — auto-pay for APIs
  // ═══════════════════════════════════════════════════════════

  server.tool(
    's402_fetch',
    'Fetch a URL with automatic s402/x402 payment. If the server returns HTTP 402, ' +
      'this tool automatically pays the requested amount in SUI and retries. ' +
      'Returns the API response along with payment details. ' +
      'Per-request payment is capped and cannot exceed the server-wide maximum.',
    {
      url: z.string().describe('The URL to fetch'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'])
        .default('GET')
        .describe('HTTP method (default: GET)'),
      headers: z
        .record(z.string())
        .optional()
        .describe('Additional HTTP headers to send'),
      body: z
        .string()
        .optional()
        .describe('Request body (for POST/PUT/PATCH)'),
      maxPayment: z
        .string()
        .optional()
        .describe(
          'Lower the payment cap for this request (in MIST). ' +
            'Cannot exceed the server-wide S402_MAX_PAYMENT. ' +
            '1 SUI = 1,000,000,000 MIST.',
        ),
    },
    async ({ url, method, headers: extraHeaders, body, maxPayment }) => {
      try {
        // ── Security: URL validation (SSRF protection) ──
        validateUrl(url);

        // ── Security: Clamp per-request cap (never exceeds server config) ──
        let cap = config.maxPayment;
        if (maxPayment) {
          const requested = BigInt(maxPayment);
          if (requested > 0n && requested < cap) cap = requested;
          // If requested >= config.maxPayment, silently use config.maxPayment
        }

        // ── Security: Sanitize user-provided headers ──
        const safeHeaders = sanitizeHeaders(extraHeaders);

        // 1. Make the initial request
        const fetchOpts: RequestInit = {
          method,
          headers: safeHeaders,
          signal: AbortSignal.timeout(config.timeoutMs),
        };
        if (body && method !== 'GET' && method !== 'HEAD') fetchOpts.body = body;

        const res = await fetch(url, fetchOpts);

        // 2. If not 402, return the response directly
        if (res.status !== 402) {
          const responseBody = await readBody(res);
          return jsonResponse({
            status: res.status,
            statusText: res.statusText,
            body: responseBody,
            paid: false,
          });
        }

        // 3. Extract payment requirements (s402 or x402)
        const requirements = extractRequirements(res);
        if (!requirements) {
          return jsonResponse(
            {
              error:
                'Server returned 402 but no parseable s402/x402 payment requirements.',
              status: 402,
            },
            true,
          );
        }

        // ── Security: Check expiration (S1 invariant — stale payment rejection) ──
        if (
          requirements.expiresAt != null &&
          requirements.expiresAt < Date.now()
        ) {
          return jsonResponse(
            {
              error: 'Payment requirements have expired.',
              expiresAt: requirements.expiresAt,
              serverTime: Date.now(),
              suggestion: 'Retry the request to get fresh requirements.',
            },
            true,
          );
        }

        // ── Security: Validate asset (only SUI gas coin supported) ──
        if (requirements.asset !== SUI_COIN_TYPE) {
          return jsonResponse(
            {
              error: `Only SUI payments are supported. Server requires asset: "${requirements.asset}".`,
              supported: SUI_COIN_TYPE,
            },
            true,
          );
        }

        // ── Security: Validate amount ──
        const amount = BigInt(requirements.amount);
        if (amount <= 0n) {
          return jsonResponse(
            { error: 'Invalid payment amount: must be positive.' },
            true,
          );
        }
        if (!isValidU64Amount(requirements.amount)) {
          return jsonResponse(
            { error: 'Payment amount exceeds u64 maximum.' },
            true,
          );
        }

        // ── Security: Per-request cap ──
        if (amount > cap) {
          return jsonResponse(
            {
              error:
                `Payment amount ${mistToSui(amount)} exceeds cap ${mistToSui(cap)}. ` +
                `Adjust S402_MAX_PAYMENT env to increase the server-wide limit.`,
              required: {
                amount: requirements.amount,
                amountSui: mistToSui(amount),
                asset: requirements.asset,
                network: requirements.network,
                schemes: requirements.accepts,
              },
            },
            true,
          );
        }

        // ── Security: Session budget check ──
        if (sessionSpend + amount > config.sessionBudget) {
          return jsonResponse(
            {
              error:
                `Session spending limit reached. Spent ${mistToSui(sessionSpend)} of ` +
                `${mistToSui(config.sessionBudget)} budget. This request needs ${mistToSui(amount)}.`,
              sessionSpend: sessionSpend.toString(),
              sessionBudget: config.sessionBudget.toString(),
              suggestion:
                'Restart the MCP server or increase S402_SESSION_BUDGET.',
            },
            true,
          );
        }

        // ── Security: Network compatibility ──
        if (requirements.network !== config.network) {
          return jsonResponse(
            {
              error:
                `Network mismatch: server requires "${requirements.network}" ` +
                `but this MCP server is configured for "${config.network}".`,
            },
            true,
          );
        }

        // 6. Build the payment
        const payload = await paymentClient.createPayment(requirements);

        // 7. Re-request with payment header
        //    Security: redirect: 'error' prevents leaking signed tx via redirect
        const paidFetchOpts: RequestInit = {
          method,
          headers: {
            ...safeHeaders,
            [S402_HEADERS.PAYMENT]: encodePaymentPayload(payload),
          },
          redirect: 'error',
          signal: AbortSignal.timeout(config.timeoutMs),
        };
        if (body && method !== 'GET' && method !== 'HEAD') {
          paidFetchOpts.body = body;
        }

        const paidRes = await fetch(url, paidFetchOpts);

        // ── Security: Double-402 detection ──
        if (paidRes.status === 402) {
          // Payment was submitted but server still returned 402.
          // The signed transaction MAY have been broadcast by the facilitator.
          sessionSpend += amount; // Assume worst case: payment was taken
          return jsonResponse(
            {
              error:
                'Payment submitted but server returned 402 again. ' +
                'The payment may have been broadcast — check your wallet balance.',
              status: 402,
              paid: 'uncertain',
              payment: {
                amount: requirements.amount,
                amountSui: mistToSui(amount),
                network: requirements.network,
                payTo: requirements.payTo,
              },
              suggestion:
                'Check s402_balance. Do NOT retry — you may be double-charged.',
            },
            true,
          );
        }

        const paidBody = await readBody(paidRes);

        // 8. Parse settlement receipt if present
        const receiptHeader = paidRes.headers.get(
          S402_HEADERS.PAYMENT_RESPONSE,
        );
        const receipt = receiptHeader
          ? decodeSettleResponse(receiptHeader)
          : null;

        // Track session spend
        sessionSpend += amount;

        return jsonResponse({
          status: paidRes.status,
          statusText: paidRes.statusText,
          body: paidBody,
          paid: true,
          payment: {
            amount: requirements.amount,
            amountSui: mistToSui(amount),
            scheme: payload.scheme,
            network: requirements.network,
            payTo: requirements.payTo,
            asset: requirements.asset,
            txDigest: receipt?.txDigest ?? null,
            finalityMs: receipt?.finalityMs ?? null,
            receiptId: receipt?.receiptId ?? null,
          },
          session: {
            totalSpent: sessionSpend.toString(),
            totalSpentSui: mistToSui(sessionSpend),
            budgetRemaining: (config.sessionBudget - sessionSpend).toString(),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, true);
      }
    },
  );

  // ═══════════════════════════════════════════════════════════
  // Tool 2: s402_check_price — peek at payment requirements
  // ═══════════════════════════════════════════════════════════

  server.tool(
    's402_check_price',
    'Check what a URL costs without paying. Fetches the URL and inspects the ' +
      '402 payment requirements. Returns pricing info, accepted schemes, and network.',
    {
      url: z.string().describe('The URL to check'),
    },
    async ({ url }) => {
      try {
        validateUrl(url);

        const res = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(config.timeoutMs),
        });

        if (res.status !== 402) {
          await res.body?.cancel();
          return jsonResponse({
            requiresPayment: false,
            status: res.status,
            message: 'This URL does not require payment.',
          });
        }

        const requirements = extractRequirements(res);
        await res.body?.cancel();
        if (!requirements) {
          return jsonResponse({
            requiresPayment: true,
            parseable: false,
            message:
              'Server returned 402 but requirements could not be parsed.',
          });
        }

        const amount = BigInt(requirements.amount);
        const withinBudget = amount <= config.maxPayment;
        const withinSessionBudget =
          sessionSpend + amount <= config.sessionBudget;
        const expired =
          requirements.expiresAt != null &&
          requirements.expiresAt < Date.now();
        const networkMatch = requirements.network === config.network;
        const assetSupported = requirements.asset === SUI_COIN_TYPE;

        return jsonResponse({
          requiresPayment: true,
          amount: requirements.amount,
          amountSui: mistToSui(amount),
          asset: requirements.asset,
          network: requirements.network,
          schemes: requirements.accepts,
          payTo: requirements.payTo,
          facilitatorUrl: requirements.facilitatorUrl ?? null,
          expiresAt: requirements.expiresAt ?? null,
          expired,
          withinBudget,
          withinSessionBudget,
          networkMatch,
          assetSupported,
          canPay:
            withinBudget &&
            withinSessionBudget &&
            networkMatch &&
            assetSupported &&
            !expired,
        });
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  // ═══════════════════════════════════════════════════════════
  // Tool 3: s402_balance — check wallet balance
  // ═══════════════════════════════════════════════════════════

  server.tool(
    's402_balance',
    'Check the SUI balance of the configured payment wallet. ' +
      'Shows balance, network, spending limits, and session usage.',
    {},
    async () => {
      try {
        const balance = await config.client.getBalance({
          owner: config.address,
        });

        const totalMist = BigInt(balance.totalBalance);

        return jsonResponse({
          address: config.address,
          balance: balance.totalBalance,
          balanceSui: mistToSui(totalMist),
          network: config.network,
          maxPaymentPerRequest: config.maxPayment.toString(),
          maxPaymentSui: mistToSui(config.maxPayment),
          sessionBudget: config.sessionBudget.toString(),
          sessionBudgetSui: mistToSui(config.sessionBudget),
          sessionSpent: sessionSpend.toString(),
          sessionSpentSui: mistToSui(sessionSpend),
          sessionRemaining: (config.sessionBudget - sessionSpend).toString(),
          coinType: balance.coinType,
        });
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );
}
