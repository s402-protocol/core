import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 's402',
  description: 'The HTTP 402 payment protocol for Sui. Five payment schemes. Built for AI agents that spend money autonomously.',
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { property: 'og:title', content: 's402 — The HTTP 402 payment protocol for Sui' }],
    ['meta', { property: 'og:description', content: 'The HTTP 402 payment protocol for Sui. Five payment schemes. From one-shot payments to prepaid API budgets. Built for AI agents that spend money autonomously.' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:image', content: '/images/og.png' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Schemes', link: '/guide/which-scheme' },
      { text: 's402 vs x402', link: '/comparison' },
      { text: 'API', link: '/api/' },
      { text: 'Whitepaper', link: '/whitepaper' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Why s402?', link: '/guide/why-s402' },
          { text: 'Quick Start', link: '/guide/quickstart' },
          { text: 'Tutorial', link: '/guide/tutorial' },
          { text: 'How It Works', link: '/guide/how-it-works' },
        ],
      },
      {
        text: 'Integrations',
        items: [
          { text: 'Claude Code (MCP)', link: '/guide/claude-code' },
          { text: 'Python (FastAPI)', link: '/guide/server-python' },
          { text: 'Go (net/http)', link: '/guide/server-go' },
        ],
      },
      {
        text: 'Payment Schemes',
        items: [
          { text: 'Which Scheme Do I Need?', link: '/guide/which-scheme' },
          { text: 'Exact', link: '/schemes/exact' },
          { text: 'Prepaid', link: '/schemes/prepaid' },
          { text: 'Escrow', link: '/schemes/escrow' },
          { text: 'Stream', link: '/schemes/stream' },
          { text: 'Unlock', link: '/schemes/unlock' },
        ],
      },
      {
        text: 'Going Deeper',
        items: [
          { text: 'Whitepaper', link: '/whitepaper' },
          { text: 'The Complete Guide', link: '/guide/the-s402-story' },
          { text: 's402 vs x402', link: '/comparison' },
          { text: 'Design Principles', link: '/architecture' },
          { text: 'Security Model', link: '/security' },
          { text: 'FAQ', link: '/faq' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Types', link: '/api/' },
          { text: 'Classes', link: '/api/classes' },
          { text: 'HTTP Helpers', link: '/api/http' },
          { text: 'Errors', link: '/api/errors' },
          { text: 'x402 Compat', link: '/api/compat' },
        ],
      },
    ],
    editLink: {
      pattern: 'https://github.com/s402-protocol/core/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/s402-protocol/core' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: '© 2026 Swee Group LLC',
    },
    search: {
      provider: 'local',
    },
  },
});
