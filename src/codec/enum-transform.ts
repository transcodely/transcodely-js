/**
 * Transcodely's wire format simplifies proto enum values: the server emits
 * `"pending"` rather than `"JOB_STATUS_PENDING"`. Standard protojson can't
 * read or write that form, so we walk the JSON tree using descriptor info
 * from the generated message types and translate enums in both directions.
 *
 * This file is the TS port of `internal/connect/codec.go` in the API repo
 * (`enumPrefix`, `simplifyEnumValue`, `expandEnumValue`). Behavior must stay
 * bit-identical — see the cross-language conformance suite.
 */

import type { EnumType, FieldInfo, MessageType } from "@bufbuild/protobuf";

type JsonObject = { [key: string]: unknown };
type Mode = "simplify" | "expand";

/** "JobStatus" → "JOB_STATUS_". The prefix the server strips/restores. */
export function enumPrefix(enumType: EnumType): string {
  return camelToScreamingSnake(simpleEnumName(enumType)) + "_";
}

function simpleEnumName(enumType: EnumType): string {
  // typeName is "transcodely.v1.JobStatus" — keep the trailing element only.
  const dot = enumType.typeName.lastIndexOf(".");
  return dot >= 0 ? enumType.typeName.slice(dot + 1) : enumType.typeName;
}

/** "JobStatus" → "JOB_STATUS"; "HLSSegmentFormat" → "HLS_SEGMENT_FORMAT". */
export function camelToScreamingSnake(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (i > 0 && /[A-Z]/.test(ch)) {
      const prev = s[i - 1]!;
      const next = s[i + 1];
      const prevLower = /[a-z]/.test(prev);
      const nextLower = next !== undefined && /[a-z]/.test(next);
      if (prevLower || nextLower) result += "_";
    }
    result += ch.toUpperCase();
  }
  return result;
}

/** "JOB_STATUS_PENDING" → "pending". */
export function simplifyEnumValue(value: string, enumType: EnumType): string {
  const prefix = enumPrefix(enumType);
  if (value.startsWith(prefix)) return value.slice(prefix.length).toLowerCase();
  return value.toLowerCase();
}

/** "pending" → "JOB_STATUS_PENDING" (uses the enum's full-name set as auth). */
export function expandEnumValue(value: string, enumType: EnumType): string {
  if (enumType.findName(value)) return value;
  const candidate = enumPrefix(enumType) + value.toUpperCase();
  if (enumType.findName(candidate)) return candidate;
  return value;
}

/** Recursively walk a JSON object and transform every enum string value. */
export function transformEnumsInJson(
  value: unknown,
  message: MessageType,
  mode: Mode,
): void {
  if (!isObject(value)) return;

  for (const field of message.fields.list()) {
    const key = pickKey(value, field);
    if (key === null) continue;
    transformField(value, key, value[key], field, mode);
  }
}

function pickKey(obj: JsonObject, field: FieldInfo): string | null {
  // Connect-ES emits jsonName by default but our codec asks for proto names;
  // accept either form for safety on input.
  if (field.jsonName !== undefined && field.jsonName in obj) return field.jsonName;
  if (field.name in obj) return field.name;
  return null;
}

function transformField(
  parent: JsonObject,
  key: string,
  v: unknown,
  field: FieldInfo,
  mode: Mode,
): void {
  if (v === null || v === undefined) return;

  // Map fields: { kind: "map", K, V: { kind, T } }
  if (field.kind === "map") {
    if (!isObject(v)) return;
    const valueKind = field.V.kind;
    if (valueKind === "enum") {
      const enumType = field.V.T;
      for (const k of Object.keys(v)) {
        const item = v[k];
        if (typeof item === "string") v[k] = applyEnum(item, enumType, mode);
      }
    } else if (valueKind === "message") {
      const msgType = field.V.T as MessageType;
      for (const k of Object.keys(v)) {
        const item = v[k];
        if (isObject(item)) transformEnumsInJson(item, msgType, mode);
      }
    }
    return;
  }

  // Repeated fields
  if (field.repeated) {
    if (!Array.isArray(v)) return;
    if (field.kind === "enum") {
      const enumType = field.T;
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (typeof item === "string") v[i] = applyEnum(item, enumType, mode);
      }
    } else if (field.kind === "message") {
      const msgType = field.T;
      for (const item of v) {
        if (isObject(item)) transformEnumsInJson(item, msgType, mode);
      }
    }
    return;
  }

  // Scalar enum
  if (field.kind === "enum") {
    if (typeof v === "string") parent[key] = applyEnum(v, field.T, mode);
    return;
  }

  // Nested message
  if (field.kind === "message") {
    if (isObject(v)) transformEnumsInJson(v, field.T, mode);
  }
}

function applyEnum(value: string, enumType: EnumType, mode: Mode): string {
  return mode === "simplify"
    ? simplifyEnumValue(value, enumType)
    : expandEnumValue(value, enumType);
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
