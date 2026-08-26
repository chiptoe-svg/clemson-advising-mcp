import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  listGcCatalogYears,
  getGcProgramPlan,
  __setGcRequirementRulesRunner,
  __resetGcRequirementRulesRunner,
  __setGcAuditRunner,
  __resetGcAuditRunner,
  AUDIT_SCHEMA_VERSION,
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

import {
  catalogYears,
  programPlan,
  requirementRules,
  genEd,
  auditProgress,
} from "../src/mcp-tools/catalog.ts";

// Phase B4: the program check comes first — a missing program was the bug
// (a Marketing question answered with the GC plan), a missing year was not.
test("programPlan handler requires a program, then a catalog year", async () => {
  const noProgram = await programPlan.handler({});
  assert.equal(noProgram.isError, true);
  assert.match((noProgram.content[0] as { text: string }).text, /program is required/);
  const noYear = await programPlan.handler({ program: "Marketing, BS" });
  assert.equal(noYear.isError, true);
  assert.match((noYear.content[0] as { text: string }).text, /catalog_year is required/);
});

test("tool definitions carry the expected names and operations", () => {
  assert.equal(catalogYears.tool.name, "list-gc-catalog-years");
  assert.equal(catalogYears.operation, "clemson.gc_catalog_years");
  assert.equal(programPlan.tool.name, "get-gc-program-plan");
  assert.equal(programPlan.operation, "clemson.gc_program_plan");
  // `required` is deliberately empty: the advisor fills an omitted program /
  // catalog_year from the session AFTER the harness validates the model's own
  // arguments, so a schema-required key would reject the call before the fill.
  assert.equal(programPlan.tool.inputSchema.required, undefined);
});

// Phase B4: this test used to pin the "Graphic Communications, BS" default.
// The default is the defect; the pin now asserts the error that replaced it.
test("get-gc-requirement-rules forwards the program and refuses to invent one", async () => {
  const seen: Array<[string, string]> = [];
  __setGcRequirementRulesRunner(async (args) => {
    // args = ["req-rules", "--year", year, "--name", name]
    seen.push([args[2], args[4]]);
    return JSON.stringify({});
  });
  let noProgram: Awaited<ReturnType<typeof requirementRules.handler>>;
  try {
    await requirementRules.handler({ catalog_year: "2026-2027", program: "Marketing, BS" });
    // The deprecated `year` alias still resolves, for one release.
    await requirementRules.handler({ year: "2026-2027", program: "Economics, BS" });
    noProgram = await requirementRules.handler({ catalog_year: "2026-2027" });
  } finally {
    __resetGcRequirementRulesRunner();
  }
  assert.deepEqual(seen, [
    ["2026-2027", "Marketing, BS"],
    ["2026-2027", "Economics, BS"],
  ]);
  assert.equal(noProgram.isError, true);
  assert.match((noProgram.content[0] as { text: string }).text, /program is required/);
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

test("every catalog tool takes program/catalog_year and closes its schema", () => {
  for (const t of [programPlan, requirementRules, genEd, auditProgress]) {
    const schema = t.tool.inputSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.ok(schema.properties?.program, `${t.tool.name} declares program`);
    assert.ok(schema.properties?.catalog_year, `${t.tool.name} declares catalog_year`);
    assert.equal(
      schema.additionalProperties,
      false,
      `${t.tool.name} rejects unknown keys instead of ignoring them`,
    );
  }
  assert.equal(
    (catalogYears.tool.inputSchema as { additionalProperties?: boolean }).additionalProperties,
    false,
  );
});

test("audit-gc-progress fills the record's program/catalog_year from the top-level args, and the record wins", async () => {
  const submitted: Record<string, unknown>[] = [];
  __setGcAuditRunner(async (json: string) => {
    submitted.push(JSON.parse(json) as Record<string, unknown>);
    return JSON.stringify({ audit_version: AUDIT_SCHEMA_VERSION, requirements: [] });
  });
  let noProgram: Awaited<ReturnType<typeof auditProgress.handler>>;
  try {
    await auditProgress.handler({
      progress: { passed: ["GC 1010"] },
      program: "Marketing, BS",
      catalog_year: "2025-2026",
    });
    await auditProgress.handler({
      progress: { passed: [], program: "Economics, BS", catalog_year: "2023-2024" },
      program: "Marketing, BS",
      catalog_year: "2025-2026",
    });
    noProgram = await auditProgress.handler({ progress: { passed: [] } });
  } finally {
    __resetGcAuditRunner();
  }
  assert.deepEqual(submitted, [
    { passed: ["GC 1010"], program: "Marketing, BS", catalog_year: "2025-2026" },
    { passed: [], program: "Economics, BS", catalog_year: "2023-2024" },
  ]);
  assert.equal(noProgram.isError, true);
  assert.match((noProgram.content[0] as { text: string }).text, /program is required/);
});

test("audit-gc-progress echoes the resolved program and catalog_year", async () => {
  __setGcAuditRunner(async () =>
    JSON.stringify({ audit_version: AUDIT_SCHEMA_VERSION, requirements: [] }),
  );
  try {
    const res = await auditProgress.handler({
      progress: { passed: [] },
      program: "Management, BS",
      catalog_year: "2026-2027",
    });
    const body = JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
    assert.equal(body.program, "Management, BS");
    assert.equal(body.catalog_year, "2026-2027");
  } finally {
    __resetGcAuditRunner();
  }
});
