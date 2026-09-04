---
title:       "@sweefi/server changelog"
kind:        reference
status:      active
updated:     2026-09-04
owner:       danny
verified_by: "N/A — narrative"
---

# Changelog

All notable changes to `@sweefi/server`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package is versioned
independently of the `s402` reference implementation it wraps.

## [Unreleased]

### Fixed

- The `402` response body is now the same x402 V2 document the `payment-required`
  header carries. It was the gate's in-memory requirement instead, which put
  `mandate` and the other s402 fields at the top of the `accepts[]` entry where no
  client reads them — so a mandate-bearing route published its spending
  authorization in the header and dropped it from the body. One response no longer
  carries two documents that disagree about what the route requires.
