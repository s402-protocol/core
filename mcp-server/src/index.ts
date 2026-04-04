#!/usr/bin/env node

/**
 * s402 MCP Server — let AI agents pay for APIs on Sui
 *
 * Exposes three tools via the Model Context Protocol:
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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerTools } from './tools.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

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
