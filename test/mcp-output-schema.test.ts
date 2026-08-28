// Structured tool output (2026-08-27).
//
// Two things are pinned here:
//   1. okJson emits BOTH structuredContent and the text block, and they agree.
//      The text block is what every current client reads; dropping it would be
//      a silent breaking change.
//   2. Any tool that declares an outputSchema actually CONFORMS to it. An
//      outputSchema is a promise to the client — a non-conforming response is a
//      protocol violation, not merely surprising — so the promise is checked
//      against real handler output, not assumed.
//
// The validator below is deliberately small and its limits are stated: it
// checks type, required, enum, nested object properties, and array item shape.
// It does NOT implement JSON Schema. It is enough to catch the realistic drift
// (a renamed field, a changed type, a dropped required key) without taking on a
// validator dependency.

import assert from "node:assert/strict";
import test from "node:test";

import { okJson, type McpToolDefinition } from "../src/mcp-tools/types.ts";
import { findCourseInProgram } from "../src/mcp-tools/catalog.ts";
import { SKIP_NO_CORE_DB, requireArtifacts } from "./_artifacts.ts";

requireArtifacts("core-db");

type Schema = Record<string, any>;

function typeOk(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case "string": return typeof value === "string";
      case "number": return typeof value === "number";
      case "integer": return Number.isInteger(value);
      case "boolean": return typeof value === "boolean";
      case "null": return value === null;
      case "array": return Array.isArray(value);
      case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
      default: return true;
    }
  });
}

/** Returns a list of human-readable violations; empty means conforming. */
function validate(value: unknown, schema: Schema, path = "$"): string[] {
  const errs: string[] = [];
  if (schema.type !== undefined && !typeOk(value, schema.type)) {
    errs.push(`${path}: expected ${JSON.stringify(schema.type)}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
    return errs; // type is wrong; deeper checks would be noise
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type === "object" || schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      // undefined counts as absent: JSON.stringify drops it on the wire.
      if (obj[key] === undefined) errs.push(`${path}.${key}: required but absent`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) errs.push(...validate(obj[key], sub as Schema, `${path}.${key}`));
    }
  }
  if (schema.type === "array" && schema.items) {
    (value as unknown[]).forEach((el, i) => errs.push(...validate(el, schema.items, `${path}[${i}]`)));
  }
  return errs;
}

// --- okJson contract --------------------------------------------------------

test("okJson emits structuredContent AND the text block, and they agree", () => {
  const data = { a: 1, nested: { b: "x" }, list: [1, 2] };
  const r = okJson(data);
  assert.deepEqual(r.structuredContent, data, "structuredContent must carry the object");
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  assert.deepEqual(JSON.parse(text), data, "text block must still carry the same payload");
});

test("okJson leaves arrays and scalars as text only", () => {
  // structuredContent is specified as an object; wrapping a list in an invented
  // envelope would describe a shape no schema declares.
  assert.equal(okJson([1, 2, 3]).structuredContent, undefined);
  assert.equal(okJson("hello").structuredContent, undefined);
  assert.equal(okJson(null).structuredContent, undefined);
});

test("okJson stays backward compatible: text is always present", () => {
  for (const payload of [{ a: 1 }, [1], "s", 3, null]) {
    const r = okJson(payload);
    assert.ok(Array.isArray(r.content) && r.content.length === 1, "text content must always be emitted");
  }
});

// --- outputSchema conformance ----------------------------------------------

const GC = "Graphic Communications, BS";

async function callStructured(tool: McpToolDefinition, args: Record<string, unknown>) {
  const r = await tool.handler(args);
  assert.ok(r.structuredContent, "handler must return structuredContent when it declares an outputSchema");
  return r.structuredContent as Record<string, unknown>;
}

test("find-course-in-program conforms to its outputSchema — found case", { skip: SKIP_NO_CORE_DB }, async () => {
  const schema = findCourseInProgram.tool.outputSchema as Schema;
  assert.ok(schema, "the tool must declare an outputSchema");
  const out = await callStructured(findCourseInProgram, {
    course: "PCID", program: GC, catalog_year: "2025-2026",
  });
  assert.deepEqual(validate(out, schema), [], "found-case response must conform");
  assert.equal(out.found, true);
});

test("find-course-in-program conforms to its outputSchema — not-found case", { skip: SKIP_NO_CORE_DB }, async () => {
  const schema = findCourseInProgram.tool.outputSchema as Schema;
  const out = await callStructured(findCourseInProgram, {
    course: "BASKET 9999", program: GC, catalog_year: "2025-2026",
  });
  assert.deepEqual(validate(out, schema), [], "not-found response must conform");
  assert.equal(out.found, false);
});

test("the validator actually rejects a non-conforming payload", () => {
  // Red-proof: a validator that accepts everything would make the two tests
  // above meaningless.
  const schema = findCourseInProgram.tool.outputSchema as Schema;
  assert.notDeepEqual(validate({}, schema), [], "missing required keys must fail");
  assert.notDeepEqual(
    validate({ query: 1, matched_as: "nope", program: "p", catalog_year: "y",
               found: "yes", plan_appearances: {}, requirement_rule_mentions: [], _source: "s" }, schema),
    [],
    "wrong types and a bad enum must fail",
  );
});
