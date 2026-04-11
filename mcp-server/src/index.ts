#!/usr/bin/env node

/**
 * s402 MCP Server — let AI agents pay for APIs on Sui
 *
 * Commands:
 *   npx s402-mcp              — Start MCP server (stdio transport)
 *   npx s402-mcp setup        — Interactive setup wizard
 *   npx s402-mcp auth refresh — Re-authenticate (zkLogin session renewal)
 *   npx s402-mcp auth status  — Show current auth status
 *
 * MCP Tools (when running as server):
 *   s402_fetch       — fetch URL with automatic 402 payment
 *   s402_check_price — peek at costs without paying
 *   s402_balance     — check wallet balance
 *
 * Usage:
 *   S402_PRIVATE_KEY=suiprivkey1... npx s402-mcp
 *
 * Claude Code config (~/.claude/settings.json):
 *   {
 *     "mcpServers": {
 *       "s402": {
 *         "command": "npx",
 *         "args": ["s402-mcp"],
 *         "env": {
 *           "S402_PRIVATE_KEY": "suiprivkey1...",
 *           "S402_NETWORK": "sui:testnet"
 *         }
 *       }
 *     }
 *   }
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

// ═══════════════════════════════════════════════════════════
// Subcommand routing
// ═══════════════════════════════════════════════════════════
//
// Check argv BEFORE importing MCP SDK — the setup wizard should
// not require S402_PRIVATE_KEY or any MCP dependencies.

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === 'setup') {
  const { runSetup } = await import('./setup.js');
  await runSetup();
  process.exit(0);
}

if (subcommand === 'auth') {
  const action = args[1] ?? 'status';
  if (action === 'refresh') {
    // TODO: zkLogin session refresh (DAN-212)
    console.error('s402-mcp: zkLogin auth refresh is coming soon.');
    console.error('Re-run `npx s402-mcp setup` to reconfigure.');
    process.exit(1);
  }
  if (action === 'status') {
    const { loadStoredConfig, loadCredentials } = await import('./store.js');
    const config = loadStoredConfig();
    const hasCreds = loadCredentials() !== null;
    if (config) {
      console.error(`s402-mcp auth status:`);
      console.error(`  Wallet:    ${config.address}`);
      console.error(`  Network:   ${config.network}`);
      console.error(`  Method:    ${config.walletMethod}`);
      console.error(`  Key:       ${hasCreds ? 'present' : 'MISSING'}`);
      console.error(`  Created:   ${config.createdAt}`);
    } else {
      console.error('s402-mcp: No configuration found. Run `npx s402-mcp setup` first.');
    }
    process.exit(0);
  }
  console.error(`s402-mcp: Unknown auth action "${action}". Use: refresh, status`);
  process.exit(1);
}

if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
  console.error(`s402-mcp v${version}`);
  process.exit(0);
}

if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  console.error(`s402-mcp v${version} — Let AI agents pay for APIs on Sui\n`);
  console.error('Commands:');
  console.error('  npx s402-mcp              Start MCP server (stdio)');
  console.error('  npx s402-mcp setup        Interactive setup wizard');
  console.error('  npx s402-mcp auth status  Show current auth status');
  console.error('  npx s402-mcp auth refresh Re-authenticate (zkLogin)');
  console.error('  npx s402-mcp version      Show version');
  console.error('  npx s402-mcp help         Show this help\n');
  console.error('Environment:');
  console.error('  S402_PRIVATE_KEY     Sui Ed25519 private key (required for server)');
  console.error('  S402_NETWORK         sui:mainnet | sui:testnet | sui:devnet');
  console.error('  S402_MAX_PAYMENT     Per-request cap in MIST (default: 10000000)');
  console.error('  S402_SESSION_BUDGET  Session spending cap in MIST (default: 100000000)');
  process.exit(0);
}

if (subcommand && !subcommand.startsWith('-')) {
  console.error(`s402-mcp: Unknown command "${subcommand}". Run \`npx s402-mcp help\` for usage.`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════
// MCP Server mode (no subcommand)
// ═══════════════════════════════════════════════════════════

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerTools } from './tools.js';

try {
  const config = loadConfig();

  const server = new McpServer({
    name: 's402',
    version,
  });

  registerTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // MCP servers communicate via stdio — errors go to stderr
  console.error(`s402-mcp: ${message}`);
  process.exit(1);
}
