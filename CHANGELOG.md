# Changelog

All notable changes to the Transcodely JavaScript / TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Breaking changes are allowed on minor bumps until 1.0.0.

## [0.1.2](https://github.com/transcodely/transcodely-js/compare/v0.1.1...v0.1.2) (2026-07-01)


### Features

* **origins:** add Cloudflare R2 as a first-class provider ([#4](https://github.com/transcodely/transcodely-js/issues/4)) ([6807153](https://github.com/transcodely/transcodely-js/commit/680715334e43a4b9968df52ab1a8d1c86fb0ac03))
* **webhooks:** add verify helper, typed events, and endpoint resources ([#6](https://github.com/transcodely/transcodely-js/issues/6)) ([97a4f3a](https://github.com/transcodely/transcodely-js/commit/97a4f3ade9ab0e7e90abf09eb414d03526e78d96))


### Bug Fixes

* **webhooks:** expand simplified enums when decoding event data ([#7](https://github.com/transcodely/transcodely-js/issues/7)) ([f05b487](https://github.com/transcodely/transcodely-js/commit/f05b487d72a77aa831e580591eebbc6b14e8af7b))

## [0.1.1](https://github.com/transcodely/transcodely-js/compare/v0.1.0...v0.1.1) (2026-05-05)


### Features

* initial 0.1.0 alpha release ([0f1d870](https://github.com/transcodely/transcodely-js/commit/0f1d87035d3dc510510bbdb5df1643089d6db6e0))

## [0.1.0] — Alpha

Initial public alpha. Covers 100% of the public RPC surface (56 RPCs across 10 services). Stripe-style facade: lazy resource namespaces, auto-pagination, auto-idempotency on `create` mutations, typed error hierarchy (1 base + 8 concrete), Watch streams with auto-reconnect, calendar-versioned API.
