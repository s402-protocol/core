import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 's402',
  description: 'Chain-agnostic HTTP 402 payment protocol for AI agents. Superset of x402 and MPP — same price or cheaper where they overlap, six payment schemes where they can\'t. TypeScript, Python, Go.',
  cleanUrls: true,
  sitemap: {
    hostname: 'https://s402-protocol.org',
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { property: 'og:title', content: 's402 — HTTP 402 for AI agents. Chain-agnostic.' }],
    ['meta', { property: 'og:description', content: 'Chain-agnostic HTTP 402 protocol for AI agents. Superset of x402 and MPP — cheaper where they overlap, uniquely expressive where they can\'t. Six payment schemes. TypeScript, Python, Go.' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:image', content: '/images/og.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 's402 — HTTP 402 for AI agents. Chain-agnostic.' }],
    ['meta', { name: 'twitter:description', content: 'Chain-agnostic HTTP 402 for AI agents. Superset of x402 and MPP. Six schemes — $0.014 gas per 1,000 calls with Prepaid on Sui.' }],
    ['meta', { name: 'twitter:image', content: '/images/og.png' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Schemes', link: '/guide/which-scheme' },
      {
        text: 'Migrating',
        items: [
          { text: 'From x402', link: '/guide/upgrade-x402' },
          { text: 'From MPP', link: '/guide/upgrade-mpp' },
        ],
      },
      { text: 'Compare', link: '/comparison' },
      { text: 'Integrations', link: '/integrations' },
      { text: 'API', link: '/api/' },
      {
        text: 'Research',
        items: [
          { text: 'Research & Security', link: '/research' },
          { text: 'Whitepaper', link: '/whitepaper' },
          { text: 'Specification', link: '/specification' },
          { text: 'Threat Model', link: '/THREAT_MODEL' },
        ],
      },
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
          { text: 'Adapter Matrix', link: '/integrations' },
          { text: 'Python', link: '/guide/server-python' },
          { text: 'Go (net/http)', link: '/guide/server-go' },
          { text: 'Conformance Vectors', link: '/guide/conformance' },
        ],
      },
      {
        text: 'Payment Schemes',
        items: [
          { text: 'Which Scheme Do I Need?', link: '/guide/which-scheme' },
          { text: 'Exact', link: '/schemes/exact' },
          { text: 'Upto', link: '/schemes/upto' },
          { text: 'Prepaid', link: '/schemes/prepaid' },
          { text: 'Escrow', link: '/schemes/escrow' },
          { text: 'Stream', link: '/schemes/stream' },
          { text: 'Unlock', link: '/schemes/unlock' },
        ],
      },
      {
        text: 'Migrating',
        items: [
          { text: 'From x402', link: '/guide/upgrade-x402' },
          { text: 'From MPP', link: '/guide/upgrade-mpp' },
        ],
      },
      {
        text: 'Going Deeper',
        items: [
          { text: 'The Complete Guide', link: '/guide/the-s402-story' },
          { text: 'Compare: s402 vs x402 vs MPP', link: '/comparison' },
          { text: 'Design Principles', link: '/architecture' },
          { text: 'Fee Ownership & Trust', link: '/guide/fee-ownership' },
          { text: 'FAQ', link: '/faq' },
        ],
      },
      {
        text: 'Research & Security',
        items: [
          { text: 'Research Hub', link: '/research' },
          { text: 'Whitepaper', link: '/whitepaper' },
          { text: 'Wire Format Spec', link: '/specification' },
          { text: 'Threat Model', link: '/THREAT_MODEL' },
          { text: 'Security Model', link: '/security' },
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
      message: 'Released under the Apache 2.0 License.',
      copyright: '© 2026 Swee Group LLC',
    },
    search: {
      provider: 'local',
    },
  },
});
