import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 's402',
  description: 'Sui-native HTTP 402 protocol. Wire-compatible with x402. Atomic settlement via PTBs.',
  head: [
    ['meta', { property: 'og:title', content: 's402 — Sui-native HTTP 402 protocol' }],
    ['meta', { property: 'og:description', content: 'Wire-compatible with x402. Atomic settlement via PTBs. Five payment schemes. Zero runtime dependencies.' }],
    ['meta', { property: 'og:type', content: 'website' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Comparison', link: '/comparison' },
      { text: 'API', link: '/api/' },
      { text: 'GitHub', link: 'https://github.com/s402-protocol/core' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is s402?', link: '/' },
          { text: 'Quick Start', link: '/guide/quickstart' },
          { text: 'How It Works', link: '/guide/how-it-works' },
        ],
      },
      {
        text: 'Comparison',
        items: [
          { text: 's402 vs x402', link: '/comparison' },
        ],
      },
      {
        text: 'Payment Schemes',
        items: [
          { text: 'Exact', link: '/schemes/exact' },
          { text: 'Prepaid', link: '/schemes/prepaid' },
          { text: 'Escrow', link: '/schemes/escrow' },
          { text: 'Stream', link: '/schemes/stream' },
          { text: 'Seal', link: '/schemes/seal' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Types', link: '/api/' },
          { text: 'HTTP Helpers', link: '/api/http' },
          { text: 'Errors', link: '/api/errors' },
          { text: 'x402 Compat', link: '/api/compat' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Design Principles', link: '/architecture' },
          { text: 'Security', link: '/security' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/s402-protocol/core' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2026 Pixel Drift Co',
    },
    search: {
      provider: 'local',
    },
  },
});
