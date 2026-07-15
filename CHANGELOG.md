# Changelog

All notable changes to the Transcodely JavaScript / TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Breaking changes are allowed on minor bumps until 1.0.0.

## [0.3.0](https://github.com/transcodely/transcodely-js/compare/v0.2.0...v0.3.0) (2026-07-15)


### ⚠ BREAKING CHANGES

* App.webhook, CreateAppRequest.webhook, and UpdateAppRequest.webhook (WebhookConfig / CreateWebhookConfig / UpdateWebhookConfig) are removed. App-level webhook configuration is superseded by the WebhookService endpoints API, already exposed in this SDK as client.webhookEndpoints (create / update / rotateSecret / list / sendTest) and client.webhooks.constructEvent for signature verification.

### Features

* sync protos — explicit app scoping; remove legacy app webhook config ([#21](https://github.com/transcodely/transcodely-js/issues/21)) ([10b65fe](https://github.com/transcodely/transcodely-js/commit/10b65fece1c090c0298f24ff9f34554fdfbe9bd5))

## [0.2.0](https://github.com/transcodely/transcodely-js/compare/v0.1.4...v0.2.0) (2026-07-12)


### ⚠ BREAKING CHANGES

* The APIKeyEnvironment enum and its API-key `environment` field are removed, and webhook events no longer expose `livemode`. Code that read `event.livemode` or referenced `APIKeyEnvironment` must be updated.

### Features

* proto resync (rotation + measured output metrics), null request.id vector, wire-type docs ([#15](https://github.com/transcodely/transcodely-js/issues/15)) ([b50fac9](https://github.com/transcodely/transcodely-js/commit/b50fac9a5778642ab5887347bd117fed32ac5a2d))
* remove API-key environment and webhook livemode ([#18](https://github.com/transcodely/transcodely-js/issues/18)) ([80d05ab](https://github.com/transcodely/transcodely-js/commit/80d05ab5a45a592e8b42487c420074d23f2228e1))


### Documentation

* commit CLAUDE.md (was untracked — the routine fleet reads it via the GitHub API) ([3a494f3](https://github.com/transcodely/transcodely-js/commit/3a494f36d7f2416984097ec9cec72a58efb6ea37))

## [0.1.4](https://github.com/transcodely/transcodely-js/compare/v0.1.3...v0.1.4) (2026-07-07)


### Documentation

* **examples:** add S3-compatible (custom-endpoint) origin example ([#11](https://github.com/transcodely/transcodely-js/issues/11)) ([1d262f7](https://github.com/transcodely/transcodely-js/commit/1d262f7193fefd09f63279921d8781c6f45ae14f))

## [0.1.3](https://github.com/transcodely/transcodely-js/compare/v0.1.2...v0.1.3) (2026-07-02)


### Features

* resync proto — thumbnail path_template + accumulated drift ([#9](https://github.com/transcodely/transcodely-js/issues/9)) ([b304946](https://github.com/transcodely/transcodely-js/commit/b30494607e4b969014654e75fc7e3832bc4ad79e))


### Bug Fixes

* **webhooks:** accept null request.id in envelope ([#8](https://github.com/transcodely/transcodely-js/issues/8)) ([b1c2b70](https://github.com/transcodely/transcodely-js/commit/b1c2b7073b814b8aba4ac2e4c438d291ae7461ca))

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
