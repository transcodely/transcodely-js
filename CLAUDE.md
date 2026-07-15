# Transcodely TypeScript SDK

`@transcodely/sdk` — the official TypeScript/JS SDK, generated from the api repo's
public protos (`buf generate` → `src/gen`) with hand-written resource classes in
`src/resources/`. Wire format is snake_case JSON + simplified lowercase enums (a port
of the api repo's `internal/connect/codec.go`); generated TS properties are camelCase
(`disable_audio` on the wire → `disableAudio` in code). Upstream (`../api`) is
authoritative for wire/enum/error behavior.

- Regenerate from proto: `./scripts/sync-protos.sh && buf generate`
- Build / check / test: `pnpm build` (tsup) · `pnpm typecheck` (tsc --noEmit) · `pnpm test` (vitest)

## Docs are the contract (drift)

The public docs (`transcodely/web` → `src/routes/(docs)/docs/**`, especially
`getting-started/sdks/typescript` and the per-resource SDK method maps such as the one
in `api-reference/webhooks`) document this SDK's exact public surface. Rules:

- Any public-surface change (methods, param object shapes, exported enums, webhook
  event types, error classes) must be mirrored in those web docs pages **in the same
  release window**. Web's mechanical drift gate validates proto-level facts but does
  NOT parse `ts` code fences — whoever changes this SDK owns the docs snippets.
- Before renaming/removing anything public, grep the web repo's docs for usages
  (` ```typescript ` fences calling `client.<resource>.<method>` and named imports
  from `@transcodely/sdk`); docs may also reference capabilities that shipped here first.
- Six generated enums keep their full proto prefix in member identifiers
  (`DRMSystem.DRM_SYSTEM_WIDEVINE`, `HDRFormat.HDR_FORMAT_HDR10`, `HDRMode`,
  `HLSSegmentFormat`, `HLSPlaylistType`, `GOPAlignmentMode`) — docs snippets using
  shorthand members for these will not type-check.
- Vendored proto comments flow into generated code and docs — when resyncing, take
  the api repo's comments verbatim (they are maintained as public documentation there).

---

## TODO: surface `disable_audio` + single-variant streaming presets

Upstream API changes this SDK still needs to expose (api PR #119, worker PR #57).

### What changed in the API
1. **`disable_audio` (video-only output).** New field:
   - `OutputSpec.disable_audio` — `optional bool`, override semantics: when unset
     it inherits the referenced preset's value; `true` drops audio for that output.
   - `Preset.disable_audio` (`bool`) plus `CreatePresetRequest` / `UpdatePresetRequest`.
   - Wire name is snake_case `disable_audio` (→ `disableAudio` in generated TS). The
     server rejects `disable_audio: true` combined with explicit `audio[]` tracks
     (`parameter_invalid`).
   - Pricing is unchanged (no audio cost component).
2. **Graceful no-audio sources.** A source video with no audio track no longer fails
   packaging — it now produces a valid video-only output automatically (worker PR #57).
   No SDK code change; worth a line in the README / audio docs.
3. **Single-variant streaming presets.** The API dropped the "minimum 2 ABR variants"
   rule, so a single-variant HLS/DASH/CMAF preset is now valid (e.g. one vertical 720p
   HLS stream). No proto change — just relax any client-side mirror and update examples.

### Work items
- [x] `./scripts/sync-protos.sh && buf generate` — DONE: `disableAudio` is present in
      `src/gen/transcodely/v1/job_pb.ts` and the preset types (verified 2026-07-15).
      Pass via `{ type: OutputFormat.HLS, video: [...], disableAudio: true }`.
- [ ] Add an `examples/` demo creating a video-only output (and/or a single-variant
      streaming preset).
- [ ] Add a vitest case asserting it serializes to `"disable_audio": true` on the wire
      (follow the existing codec tests).
- [ ] Update `README.md` + `CHANGELOG.md` (release-please) when it lands.
- [ ] Blocked on api PR #119 (proto) merging first.

Refs: transcodely/api#119, transcodely/worker#57.
