import type { JsonValue } from "../types.js";

function normalize(value: unknown, seen: Set<object>): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Cannot serialize cyclic value");
    seen.add(value);
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined) output[key] = normalize(field, seen);
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set<object>()));
}

export function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(normalize(value, new Set<object>()), null, 2)}\n`;
}
