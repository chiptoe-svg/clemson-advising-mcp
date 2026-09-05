// Catalog tool handlers against the real catalog database. Every test that
// reads the DB skips — with a stated reason — when it is absent, and
// REQUIRE_ARTIFACTS=1 (npm run test:gate) turns those skips into failures.
import { test } from "node:test";
import assert from "node:assert/strict";

import { listGcCatalogYears } from "../src/gc-curriculum.ts";
import {
  catalogYears,
  programPlan,
  requirementRules,
  genEd,
  listCourses,
} from "../src/mcp-tools/catalog.ts";
import { SKIP_NO_CORE_DB, requireCoreArtifacts } from "./_artifacts.ts";

requireCoreArtifacts();

test(
  "listGcCatalogYears against the real catalog DB",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const years = await listGcCatalogYears();
    assert.ok(Array.isArray(years) && years.length > 0);
    assert.ok(years.every((y) => /^\d{4}-\d{4}$/.test(y)));
  },
);

// The program check comes first — a missing program was the bug (a Marketing
// question answered with the GC plan), a missing year was not.
test("programPlan handler requires a program, then a catalog year", async () => {
  const noProgram = await programPlan.handler({});
  assert.equal(noProgram.isError, true);
  assert.match(
    (noProgram.content[0] as { text: string }).text,
    /program is required/,
  );
  const noYear = await programPlan.handler({ program: "Marketing, BS" });
  assert.equal(noYear.isError, true);
  assert.match(
    (noYear.content[0] as { text: string }).text,
    /catalog_year is required/,
  );
});

test("tool definitions carry the expected names and operations", () => {
  assert.equal(catalogYears.tool.name, "list-catalog-years");
  assert.equal(catalogYears.operation, "clemson.gc_catalog_years");
  assert.equal(programPlan.tool.name, "get-program-plan");
  assert.equal(programPlan.operation, "clemson.gc_program_plan");
  // `required` is deliberately empty: a client may fill an omitted program /
  // catalog_year from its own session AFTER its harness validates the model's
  // arguments, so a schema-required key would reject the call before the fill.
  assert.equal(programPlan.tool.inputSchema.required, undefined);
});

test(
  "get-requirement-rules echoes the program it was given and refuses to invent one",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const a = await requirementRules.handler({
      catalog_year: "2026-2027",
      program: "Marketing, BS",
    });
    assert.equal(a.isError, undefined, (a.content[0] as { text: string }).text);
    assert.equal(
      (a.structuredContent as { program: string }).program,
      "Marketing, BS",
    );
    // The deprecated `year` alias still resolves, for one release.
    const b = await requirementRules.handler({
      year: "2026-2027",
      program: "Economics, BS",
    });
    assert.equal(b.isError, undefined, (b.content[0] as { text: string }).text);
    assert.equal(
      (b.structuredContent as { catalog_year: string }).catalog_year,
      "2026-2027",
    );
    const noProgram = await requirementRules.handler({
      catalog_year: "2026-2027",
    });
    assert.equal(noProgram.isError, true);
    assert.match(
      (noProgram.content[0] as { text: string }).text,
      /program is required/,
    );
  },
);

test("catalog tool descriptions no longer single out Graphic Communications", () => {
  for (const t of [requirementRules, programPlan]) {
    assert.ok(
      !/Graphic Communications/.test(t.tool.description ?? ""),
      `${t.tool.name} description`,
    );
  }
  assert.ok(
    (requirementRules.tool.inputSchema.properties as Record<string, unknown>)
      .program,
    "program param declared",
  );
});

test("every catalog tool takes program/catalog_year and closes its schema", () => {
  for (const t of [programPlan, requirementRules, genEd]) {
    const schema = t.tool.inputSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.ok(schema.properties?.program, `${t.tool.name} declares program`);
    assert.ok(
      schema.properties?.catalog_year,
      `${t.tool.name} declares catalog_year`,
    );
    assert.equal(
      schema.additionalProperties,
      false,
      `${t.tool.name} rejects unknown keys instead of ignoring them`,
    );
  }
  assert.equal(
    (catalogYears.tool.inputSchema as { additionalProperties?: boolean })
      .additionalProperties,
    false,
  );
});

// General Education does not vary by program, but what comes back must still
// be what was ASKED, not a constant.
test(
  "get-gen-ed echoes the program it was given and the resolved catalog year",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const withProgram = await genEd.handler({
      program: "Marketing, BS",
      catalog_year: "2025-2026",
    });
    const a = JSON.parse(
      (withProgram.content[0] as { text: string }).text,
    ) as Record<string, unknown>;
    assert.equal(a.program, "Marketing, BS");
    assert.equal(a.catalog_year, "2025-2026");

    // The deprecated `year` alias resolves, and an omitted program echoes null
    // rather than inventing one.
    const aliasOnly = await genEd.handler({ year: "2026-2027" });
    const b = JSON.parse(
      (aliasOnly.content[0] as { text: string }).text,
    ) as Record<string, unknown>;
    assert.equal(b.program, null);
    assert.equal(b.catalog_year, "2026-2027");
  },
);

test("get-gen-ed requires a catalog year", async () => {
  const res = await genEd.handler({});
  assert.equal(res.isError, true);
  assert.match(
    (res.content[0] as { text: string }).text,
    /catalog_year is required/,
  );
});

// --- list-shaped results use `items`, not index keys (review, 2026-08-27) ----
//
// get-requirement-rules and get-gen-ed once spread an ARRAY into an
// object literal, producing {"0":{…},"1":{…},"program":…}. Harmful once okJson
// began promoting the payload to typed structuredContent, because a model is
// then handed that shape AS structure. List-shaped results belong under `items`.

test(
  "get-requirement-rules returns its list under `items`, not index keys",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const r = await requirementRules.handler({
      program: "Graphic Communications, BS",
      catalog_year: "2025-2026",
    });
    const sc = r.structuredContent as Record<string, unknown>;
    assert.ok(
      Array.isArray(sc.items),
      "the rule list must be an array under `items`",
    );
    assert.ok((sc.items as unknown[]).length > 0);
    for (const k of Object.keys(sc)) {
      assert.ok(
        !/^\d+$/.test(k),
        `index-keyed property "${k}" leaked into the result`,
      );
    }
    // The echoed identifiers must survive the reshape.
    assert.equal(sc.program, "Graphic Communications, BS");
    assert.equal(sc.catalog_year, "2025-2026");
  },
);

test(
  "get-gen-ed returns its list under `items`, not index keys",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const r = await genEd.handler({ catalog_year: "2025-2026" });
    const sc = r.structuredContent as Record<string, unknown>;
    assert.ok(
      Array.isArray(sc.items),
      "the category list must be an array under `items`",
    );
    assert.ok((sc.items as unknown[]).length > 0);
    for (const k of Object.keys(sc)) {
      assert.ok(
        !/^\d+$/.test(k),
        `index-keyed property "${k}" leaked into the result`,
      );
    }
  },
);

test(
  "the text block and structuredContent agree for list-shaped results",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    // okJson emits both; a reshape that fixed one and not the other would hand
    // two different answers to two kinds of client.
    const r = await requirementRules.handler({
      program: "Graphic Communications, BS",
      catalog_year: "2025-2026",
    });
    const text = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    assert.deepEqual(text, r.structuredContent);
  },
);

// --- the published Literature / Non-Literature split (2026-09-05) -----------

test(
  "get-gen-ed serves Arts and Humanities subcategories, and only where the page shows a split",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const res = await genEd.handler({ catalog_year: "2026-2027" });
    const b = JSON.parse((res.content[0] as { text: string }).text) as {
      items: {
        name: string;
        allowed_courses: string[];
        subcategories?: {
          name: string;
          min_credits: number;
          allowed_courses: string[];
          note?: string;
        }[];
      }[];
    };
    const ah = b.items.find((c) => c.name.includes("Arts and Humanities"));
    assert.ok(ah?.subcategories, "A&H must carry the published split");
    const names = ah!.subcategories!.map((s) => s.name);
    assert.deepEqual(names, ["Literature", "Non-Literature"]);
    const lit = ah!.subcategories![0];
    assert.ok(lit.allowed_courses.includes("ENGL 2120"));
    assert.equal(lit.min_credits, 3);
    // The open-ended sentence is part of the requirement.
    assert.match(String(lit.note), /Any 2000-level/i);
    // Sub-lists never invent courses the category itself does not allow.
    for (const s of ah!.subcategories!)
      for (const c of s.allowed_courses)
        assert.ok(ah!.allowed_courses.includes(c), `${c} not in category list`);
    // Categories without a published split carry NO subcategories field —
    // absence of the field, not an empty array pretending to be a fact.
    const comm = b.items.find((c) => c.name.includes("Communication"));
    assert.ok(comm && !("subcategories" in comm));
  },
);

// --- list-courses: the wildcard resolver -------------------------------------

test(
  "list-courses resolves a subject + range like a DegreeWorks wildcard",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const res = await listCourses.handler({
      subject: "mgt",
      number_min: 3000,
      number_max: 4999,
    });
    const b = JSON.parse((res.content[0] as { text: string }).text) as {
      count: number;
      courses: { code: string }[];
      scope: string;
    };
    assert.ok(b.count > 0 && b.count === b.courses.length);
    for (const c of b.courses) {
      assert.match(c.code, /^MGT \d{4}$/);
      const n = Number(c.code.split(" ")[1]);
      assert.ok(n >= 3000 && n <= 4999, c.code);
    }
    // The honesty line: current inventory, not year-pinned.
    assert.match(b.scope, /not catalog-year-pinned/);
  },
);

test(
  "list-courses with only a range spans subjects; catalog_year is echoed not applied",
  { skip: SKIP_NO_CORE_DB },
  async () => {
    const res = await listCourses.handler({
      number_min: 4990,
      number_max: 4999,
      catalog_year: "2025-2026",
    });
    const b = JSON.parse((res.content[0] as { text: string }).text) as {
      courses: { code: string }[];
      catalog_year?: string;
    };
    const subjects = new Set(b.courses.map((c) => c.code.split(" ")[0]));
    assert.ok(subjects.size > 1, "a bare range must span subjects");
    assert.equal(b.catalog_year, "2025-2026");
  },
);

test("list-courses without any filter is an error, not the whole catalog", async () => {
  const res = await listCourses.handler({});
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /at least one filter/);
});
