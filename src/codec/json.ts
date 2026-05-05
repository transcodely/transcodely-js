/**
 * JSON serialization for the Transcodely wire format. Wraps protojson
 * (`MessageType.toJson` / `fromJson`) with snake_case field names + lowercase
 * simplified enum values, mirroring `internal/connect/codec.go` on the server.
 */

import type { Message, MessageType, JsonValue } from "@bufbuild/protobuf";

import { transformEnumsInJson } from "./enum-transform.js";

export interface SerializeOptions {
  /** Always emit unpopulated fields (matches server's EmitUnpopulated). */
  emitDefaultValues?: boolean;
}

const DEFAULT_OPTS: Required<SerializeOptions> = {
  emitDefaultValues: true,
};

/**
 * Serialize a generated message to a Buffer of JSON bytes in the Transcodely
 * wire format (snake_case fields, simplified lowercase enums).
 */
export function serialize<T extends Message<T>>(
  msg: T,
  type: MessageType<T>,
  opts: SerializeOptions = {},
): Uint8Array {
  const merged = { ...DEFAULT_OPTS, ...opts };
  const obj = msg.toJson({
    useProtoFieldName: true,
    emitDefaultValues: merged.emitDefaultValues,
    enumAsInteger: false,
  }) as JsonValue;
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    transformEnumsInJson(obj, type, "simplify");
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Deserialize JSON bytes (Transcodely wire format) into a generated message
 * instance. Accepts either form on input for forward compatibility.
 */
export function deserialize<T extends Message<T>>(
  bytes: Uint8Array,
  type: MessageType<T>,
): T {
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return new type();
  const parsed = JSON.parse(text);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    transformEnumsInJson(parsed, type, "expand");
  }
  return type.fromJson(parsed, { ignoreUnknownFields: true });
}

/** Same as `deserialize` but takes an already-parsed JsonValue. */
export function fromJson<T extends Message<T>>(
  json: JsonValue,
  type: MessageType<T>,
): T {
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    transformEnumsInJson(json, type, "expand");
  }
  return type.fromJson(json, { ignoreUnknownFields: true });
}
