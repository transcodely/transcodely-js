/**
 * Enum-drift guard for the hand-written facade.
 *
 * Three links have to stay in step, and each one is checked here rather than
 * by eye:
 *
 *   vendored proto  →  src/gen (buf generate)  →  src/index.ts (the facade)
 *
 * The first link catches a `sync-protos.sh` that ran without a following
 * `buf generate`. The second catches the drift this file was written for: a
 * proto enum that exists in the generated code but was never re-exported from
 * the facade, so a consumer of `@transcodely/sdk` cannot name it at all
 * (`HealthStatus` was exactly that). The third pins the wire spelling to the
 * lowercase simplified form the API's codec emits.
 *
 * Nothing here is a hand-maintained list of members: every expectation is
 * derived, so a new enum value in the api repo lands as a test failure the
 * moment the protos are resynced rather than as a silent gap in the SDK.
 *
 * The one hand-maintained mirror that cannot be derived — the webhook event
 * catalog, which has no proto enum behind it — is guarded separately in
 * tests/webhooks/catalog.test.ts.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { proto3, type EnumType } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { expandEnumValue, simplifyEnumValue } from "../src/codec/enum-transform.js";
import * as sdk from "../src/index.js";

/** Every generated module, imported for its side-effect-free exports. */
const generatedModules = import.meta.glob("../src/gen/transcodely/v1/*_pb.ts", {
  eager: true,
}) as Record<string, Record<string, unknown>>;

/**
 * A generated proto enum is a plain object registered with the runtime by
 * `proto3.util.setEnumType`. Message classes are functions and every other
 * export is either a type (erased) or a non-registered object, so asking the
 * runtime is a sharper test than any naming convention.
 */
function asEnumType(value: unknown): EnumType | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return proto3.getEnumType(value as Parameters<typeof proto3.getEnumType>[0]);
  } catch {
    return undefined;
  }
}

interface GeneratedEnum {
  /** Exported identifier, e.g. `"JobStatus"`. */
  name: string;
  /** The enum object itself, for identity comparison against the facade. */
  object: object;
  /** Runtime descriptor: full proto names and numbers. */
  type: EnumType;
}

const generatedEnums: GeneratedEnum[] = Object.values(generatedModules)
  .flatMap((module) =>
    Object.entries(module).flatMap(([name, value]) => {
      const type = asEnumType(value);
      return type ? [{ name, object: value as object, type }] : [];
    }),
  )
  // Codepoint order, matching a bare Array.prototype.sort() on the proto-side
  // names — localeCompare would order DRMSystem/DeliveryFormat differently and
  // the two lists would never line up.
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Proto member names of a generated enum, in declaration order. */
function generatedMembers(entry: GeneratedEnum): string[] {
  return entry.type.values.map((v) => v.name);
}

// ---------------------------------------------------------------------------
// Link 1: vendored proto → generated code
// ---------------------------------------------------------------------------

const protoDir = fileURLToPath(new URL("../proto/transcodely/v1", import.meta.url));

/**
 * Members of every top-level `enum` block in the vendored protos, parsed from
 * the source rather than from a descriptor set so the test has an opinion that
 * is independent of `buf generate` having been run.
 *
 * Only the shapes this schema actually uses are handled: top-level enums (there
 * are no nested ones), `reserved` lines, and comments — none of which match the
 * member pattern.
 */
function parseProtoEnums(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(protoDir).filter((f) => f.endsWith(".proto"))) {
    const lines = readFileSync(join(protoDir, file), "utf8").split("\n");
    let current: string | null = null;
    let members: string[] = [];
    for (const line of lines) {
      if (current === null) {
        const open = /^enum\s+(\w+)\s*\{/.exec(line);
        if (open) {
          current = open[1]!;
          members = [];
        }
        continue;
      }
      if (/^\}/.test(line)) {
        found.set(current, members);
        current = null;
        continue;
      }
      const member = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*\d+\s*;/.exec(line);
      if (member) members.push(member[1]!);
    }
  }
  return found;
}

const protoEnums = parseProtoEnums();

describe("vendored protos → generated code", () => {
  it("finds every enum in both places", () => {
    expect([...protoEnums.keys()].sort()).toEqual(generatedEnums.map((e) => e.name));
  });

  it.each(generatedEnums.map((e) => e.name))(
    "%s has exactly the members its .proto declares",
    (name) => {
      const entry = generatedEnums.find((e) => e.name === name)!;
      expect(generatedMembers(entry)).toEqual(protoEnums.get(name));
    },
  );
});

// ---------------------------------------------------------------------------
// Link 2: generated code → the public facade
// ---------------------------------------------------------------------------

describe("generated code → the public facade", () => {
  it.each(generatedEnums.map((e) => e.name))("re-exports %s from src/index.ts", (name) => {
    const exported = (sdk as Record<string, unknown>)[name];
    expect(
      exported,
      `${name} is a proto enum in src/gen but is not exported from src/index.ts — ` +
        `consumers of @transcodely/sdk cannot name it`,
    ).toBeDefined();
  });

  it.each(generatedEnums.map((e) => e.name))(
    "%s on the facade is the generated enum itself, not a copy",
    (name) => {
      const entry = generatedEnums.find((e) => e.name === name)!;
      const exported = (sdk as Record<string, unknown>)[name];
      // Identity, so a hand-written stand-in (the drift this suite guards)
      // fails here rather than passing a member-by-member comparison it was
      // updated to satisfy.
      expect(exported).toBe(entry.object);
    },
  );

  it.each(generatedEnums.map((e) => e.name))(
    "%s exposes every proto member as a facade member",
    (name) => {
      const entry = generatedEnums.find((e) => e.name === name)!;
      const exported = (sdk as Record<string, unknown>)[name] as Record<string, unknown>;
      // A generated TS enum usually drops the SCREAMING_SNAKE prefix
      // (JOB_STATUS_PARTIAL is `JobStatus.PARTIAL`) but not always — six enums
      // keep the full name because the bare remainder would not be a valid
      // identifier or the acronym breaks the casing rule (Resolution,
      // DRMSystem, HDRFormat, HDRMode, HLSSegmentFormat, HLSPlaylistType,
      // GOPAlignmentMode). `localName` is the runtime's own answer to that
      // question, so the expectation follows the generator instead of guessing.
      const expectedIdentifiers = entry.type.values.map((v) => v.localName);
      const actual = Object.keys(exported).filter((k) => Number.isNaN(Number(k)));
      expect([...actual].sort()).toEqual([...expectedIdentifiers].sort());
      // …and each identifier maps to its proto number in both directions.
      for (const value of entry.type.values) {
        expect(exported[value.localName]).toBe(value.no);
        expect(exported[String(value.no)]).toBe(value.localName);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Link 3: wire spelling
// ---------------------------------------------------------------------------

describe("wire spelling", () => {
  it.each(generatedEnums.map((e) => e.name))(
    "%s simplifies to lowercase and expands back unchanged",
    (name) => {
      const entry = generatedEnums.find((e) => e.name === name)!;
      for (const member of generatedMembers(entry)) {
        const wire = simplifyEnumValue(member, entry.type);
        expect(wire, `${member} must be lowercase on the wire`).toBe(wire.toLowerCase());
        expect(wire).toMatch(/^[a-z0-9_]+$/);
        expect(expandEnumValue(wire, entry.type), `${wire} must round-trip`).toBe(member);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The enums the facade documents by name, pinned so a rename is loud.
// ---------------------------------------------------------------------------

describe("JobStatus", () => {
  it("covers every status the API can report, including the two late arrivals", () => {
    // PARTIAL (7) and AWAITING_CONFIRMATION (8) were appended after the first
    // SDK release; a consumer switching on job.status needs both to exist.
    expect(Object.keys(sdk.JobStatus).filter((k) => Number.isNaN(Number(k))).sort()).toEqual([
      "AWAITING_CONFIRMATION",
      "CANCELED",
      "COMPLETED",
      "FAILED",
      "PARTIAL",
      "PENDING",
      "PROBING",
      "PROCESSING",
      "UNSPECIFIED",
    ]);
  });
});
