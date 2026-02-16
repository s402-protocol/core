# Security Policy

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

If you discover a security issue in s402, please report it privately:

- **Email:** dannydevs@proton.me
- **Subject line:** `[s402 security] <brief description>`

You will receive an acknowledgment within 48 hours. We aim to provide a fix or mitigation plan within 7 days of confirmation.

## Scope

This policy covers the `s402` npm package — the protocol types, HTTP encoding/decoding, scheme registry, and compat layer.

Security issues in downstream packages (`@sweepay/sui`, `@sweepay/sdk`, etc.) should be reported to the same email.

## What qualifies

- Wire format parsing vulnerabilities (header injection, base64 decode exploits)
- Type confusion that could lead to incorrect payment verification
- Compat layer normalization bugs that silently alter payment amounts
- Anything that could cause funds loss, incorrect settlement, or unauthorized access

## What does not qualify

- Bugs in example code or documentation
- Denial-of-service via malformed input (we validate and throw typed errors)
- Issues in development dependencies (vitest, tsdown, etc.)

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will:

1. Credit the reporter (unless anonymity is requested)
2. Publish a security advisory on GitHub
3. Release a patched version on npm

Thank you for helping keep s402 secure.
