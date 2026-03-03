# Contributing to s402

Thanks for your interest in contributing to s402! This project is Apache-2.0 licensed and welcomes contributions.

## Getting Started

```bash
git clone https://github.com/s402-protocol/core.git
cd core
pnpm install
pnpm test
```

## Development

- **Tests**: `pnpm test` — all tests must pass before submitting a PR
- **Type check**: `pnpm typecheck`
- **Build**: `pnpm build`

## Conformance Vectors

s402 includes 133 machine-readable JSON test vectors in `test/conformance/vectors/`. These ship in the npm package and are used by cross-language implementations.

If you modify any encode/decode logic in `src/http.ts`, `src/compat.ts`, or `src/receipts.ts`, regenerate the vectors:

```bash
npx tsx test/conformance/generate-vectors.ts
pnpm test  # verify conformance tests still pass
```

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests as needed
4. Regenerate conformance vectors if encode/decode logic changed
5. Ensure `pnpm test` and `pnpm typecheck` pass
6. Open a PR with a clear description of what changed and why

## Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Node version and OS

## Security

If you discover a security vulnerability, please report it responsibly via the process described in [SECURITY.md](./SECURITY.md). Do not open a public issue for security vulnerabilities.

## Code of Conduct

Be respectful. We're all here to build something useful.
