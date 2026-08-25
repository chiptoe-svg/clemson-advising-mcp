import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  listGcCatalogYears,
  getGcProgramPlan,
  __setGcRequirementRulesRunner,
  __resetGcRequirementRulesRunner,
} from "../src/gc-curriculum.ts";
import { GC_ADVISOR_DB } from "../src/config.ts";
import { listGcCatalogYears as listLive } from "../src/gc-curriculum.ts";

test("listGcCatalogYears calls the runner with ['years'] and parses JSON", async () => {
  const run = async (args: string[]) => {
    assert.deepEqual(args, ["years"]);
    return JSON.stringify(["2026-2027", "2025-2026"]);
  };
  const years = await listGcCatalogYears(run);
  assert.deepEqual(years, ["2026-2027", "2025-2026"]);
});

test("getGcProgramPlan passes year+name and parses the plan JSON", async () => {
  const run = async (args: string[]) => {
    assert.deepEqual(args, [
      "program-plan", "--year", "2026-2027", "--name", "Graphic Communications, BS",
    ]);
    return JSON.stringify({ total_credits: 120, groups: [] });
  };
  const plan = await getGcProgramPlan("2026-2027", "Graphic Communications, BS", run);
  assert.equal((plan as { total_credits: number }).total_credits, 120);
});

test("listGcCatalogYears against the real gc_advisor DB", { skip: !fs.existsSync(GC_ADVISOR_DB) }, async () => {
  const years = await listLive();
  assert.ok(Array.isArray(years) && years.length > 0);
  assert.ok(years.every((y) => /^\d{4}-\d{4}$/.test(y)));
});

import { catalogYears, programPlan, requirementRules } from "../src/mcp-tools/catalog.ts";

test("programPlan handler requires a year", async () => {
  const res = await programPlan.handler({});
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /year is required/);
});

test("tool definitions carry the expected names and operations", () => {
  assert.equal(catalogYears.tool.name, "list-gc-catalog-years");
  assert.equal(catalogYears.operation, "clemson.gc_catalog_years");
  assert.equal(programPlan.tool.name, "get-gc-program-plan");
  assert.equal(programPlan.operation, "clemson.gc_program_plan");
  assert.deepEqual(programPlan.tool.inputSchema.required, ["year"]);
});

test("get-gc-requirement-rules forwards program and defaults to Graphic Communications, BS", async () => {
  const seen: Array<[string, string]> = [];
  __setGcRequirementRulesRunner(async (args) => {
    // args = ["req-rules", "--year", year, "--name", name]
    seen.push([args[2], args[4]]);
    return JSON.stringify({});
  });
  try {
    await requirementRules.handler({ year: "2026-2027", program: "Marketing, BS" });
    await requirementRules.handler({ year: "2026-2027" });
  } finally {
    __resetGcRequirementRulesRunner();
  }
  assert.deepEqual(seen, [
    ["2026-2027", "Marketing, BS"],
    ["2026-2027", "Graphic Communications, BS"],
  ]);
});

test("catalog tool descriptions no longer single out Graphic Communications", () => {
  for (const t of [requirementRules, programPlan]) {
    assert.ok(!/Graphic Communications/.test(t.tool.description ?? ""), `${t.tool.name} description`);
  }
  assert.ok(
    (requirementRules.tool.inputSchema.properties as Record<string, unknown>).program,
    "program param declared",
  );
});
