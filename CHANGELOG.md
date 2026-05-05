# Changelog

All notable changes to the Transcodely JavaScript / TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Breaking changes are allowed on minor bumps until 1.0.0.

## [0.1.1](https://github.com/transcodely/transcodely-js/compare/v0.1.0...v0.1.1) (2026-05-05)


### Features

* initial 0.1.0 alpha release ([0f1d870](https://github.com/transcodely/transcodely-js/commit/0f1d87035d3dc510510bbdb5df1643089d6db6e0))

## [0.1.0] — Alpha

Initial public alpha. Covers 100% of the public RPC surface (56 RPCs across 10 services). Stripe-style facade: lazy resource namespaces, auto-pagination, auto-idempotency on `create` mutations, typed error hierarchy (1 base + 8 concrete), Watch streams with auto-reconnect, calendar-versioned API.
