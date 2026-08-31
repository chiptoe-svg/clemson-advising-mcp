// list-programs and get-course (2026-08-28).
//
// These exist so the advisor's Program selector and course hover card can read
// the catalog over MCP instead of opening catalog.db directly — the coupling
// that stops working the moment the servers move to their own machine.
//
// The behaviour under test that is NOT obvious: an unreadable catalog must be
// an ERROR, never `found: false` and never an empty program list. The code
// being replaced collapsed both, so a catalog that had not finished loading
// rendered as every course simultaneously ceasing to exist.

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireCoreArtifacts, SKIP_NO_CORE_DB } from "./_artifacts.ts";
import {
  listProgramOptions,
  getCourseEntry,
  normalizeCourseCode,
} from "../src/catalog-read.ts";
import { CATALOG_DB } from "../src/config-mcp.ts";

// requireCoreArtifacts THROWS under REQUIRE_ARTIFACTS=1 (so the gate can never
// pass on a silently-skipped suite); SKIP_NO_CORE_DB is the per-test reason
// used when the DB is simply absent in a casual run.
requireCoreArtifacts({ python: false });
const skip = SKIP_NO_CORE_DB;

test("normalizeCourseCode accepts real shapes and rejects junk", () => {
  assert.equal(normalizeCourseCode("gc4061"), "GC 4061");
  assert.equal(normalizeCourseCode("  GC  4061 "), "GC 4061");
  assert.equal(normalizeCourseCode("MATH 1060"), "MATH 1060");
  for (const junk of ["", "hello", "1234", "TOOLONGSUBJ 1000", "GC"]) {
    assert.equal(normalizeCourseCode(junk), null, `${junk} must not normalize`);
  }
});

test("listProgramOptions returns the selector's contents", { skip }, () => {
  const db = new Database(CATALOG_DB, { readonly: true });
  try {
    const { catalogYears, programs } = listProgramOptions(db);
    assert.ok(catalogYears.length > 0, "there must be catalog years");
    assert.deepEqual(
      [...catalogYears].sort().reverse(),
      catalogYears,
      "catalog years must be newest first",
    );
    assert.ok(programs.length > 0, "there must be programs");
    for (const p of programs) {
      assert.ok(p.name.length > 0);
      assert.ok(
        p.years.length > 0,
        `${p.name} must exist in at least one year`,
      );
    }
    // Every registrar program name contains a comma ("Accounting, BS"). If that
    // ever stops being true, formatProgramList's quoting rationale changes.
    assert.ok(
      programs.some((p) => p.name.includes(",")),
      "registrar names contain commas",
    );
  } finally {
    db.close();
  }
});

test("listProgramOptions EXCLUDES a major with no plan, on a synthetic catalog", () => {
  // Red-proofing caught the differential test below unable to see this
  // (2026-08-28): loosening the WHERE clause to `kind = 'major'` left it green,
  // because every major in the real database happens to have plan items. A
  // differential whose oracle cannot disagree on the available data proves
  // nothing about the clause it is meant to pin. Build the disagreement.
  const p = path.join(os.tmpdir(), `synthetic-${process.pid}.db`);
  fs.rmSync(p, { force: true });
  const db = new Database(p);
  try {
    db.exec(`
      CREATE TABLE catalog_year (id INTEGER PRIMARY KEY, label TEXT);
      CREATE TABLE program (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, catalog_year_id INTEGER);
      CREATE TABLE requirement_group (id INTEGER PRIMARY KEY, program_id INTEGER);
      CREATE TABLE plan_item (id INTEGER PRIMARY KEY, group_id INTEGER);
      INSERT INTO catalog_year (id, label) VALUES (1, '2026-2027');
      INSERT INTO program (id, name, kind, catalog_year_id) VALUES
        (1, 'Has Plan, BS',  'major',        1),
        (2, 'No Plan, BS',   'major',        1),
        (3, 'Pre-Business',  'pre_business', 1),
        (4, 'Some Minor',    'minor',        1);
      INSERT INTO requirement_group (id, program_id) VALUES (10, 1), (11, 2);
      INSERT INTO plan_item (id, group_id) VALUES (100, 10);
    `);
    const names = listProgramOptions(db)
      .programs.map((x) => x.name)
      .sort();
    assert.deepEqual(
      names,
      ["Has Plan, BS", "Pre-Business"],
      "a major with a requirement_group but NO plan_item must be excluded, " +
        "and so must a minor; Pre-Business is included despite having no plan",
    );
  } finally {
    db.close();
    fs.rmSync(p, { force: true });
  }
});

test(
  "listProgramOptions matches the query it replaced, exactly",
  { skip },
  () => {
    // The advisor's selector must not change contents as a side effect of moving
    // where the read happens. Same SQL, run independently here.
    const db = new Database(CATALOG_DB, { readonly: true });
    try {
      const ported = listProgramOptions(db);
      const oracleRows = db
        .prepare(
          `SELECT p.name AS name, cy.label AS year
           FROM program p
           JOIN catalog_year cy ON cy.id = p.catalog_year_id
          WHERE p.kind = 'pre_business'
             OR (p.kind = 'major'
                 AND EXISTS (SELECT 1 FROM requirement_group rg
                               JOIN plan_item pi ON pi.group_id = rg.id
                              WHERE rg.program_id = p.id))
          ORDER BY p.name ASC, cy.label DESC`,
        )
        .all() as { name: string; year: string }[];
      const expected = new Map<string, string[]>();
      for (const r of oracleRows) {
        const l = expected.get(r.name) ?? [];
        if (!l.includes(r.year)) l.push(r.year);
        expected.set(r.name, l);
      }
      assert.deepEqual(
        ported.programs,
        [...expected.entries()].map(([name, years]) => ({ name, years })),
      );
    } finally {
      db.close();
    }
  },
);

test(
  "getCourseEntry finds a real course and misses a fake one",
  { skip },
  () => {
    const db = new Database(CATALOG_DB, { readonly: true });
    try {
      const anyCode = (
        db.prepare("SELECT code FROM course LIMIT 1").get() as
          { code: string } | undefined
      )?.code;
      assert.ok(anyCode, "the catalog must contain at least one course");
      const hit = getCourseEntry(db, anyCode!);
      assert.ok(hit, "a real code must be found");
      assert.equal(hit!.code, anyCode);
      assert.equal(
        getCourseEntry(db, "ZZZZ 9999"),
        null,
        "a fake code must miss",
      );
    } finally {
      db.close();
    }
  },
);

test("THE TOOL reports an unreadable catalog as an ERROR, not as found:false", async () => {
  // Red-proofing caught this test missing entirely (2026-08-28). The version
  // below it asserts that the PRIMITIVES differ — getCourseEntry returns null,
  // new Database throws. Nothing asserted that the tool HANDLES the difference,
  // so replacing its error path with `okJson({found:false})` — the precise bug
  // this whole design exists to prevent — left the suite green.
  //
  // A child process, because CATALOG_DB is read at module load.
  const { execFileSync } = await import("node:child_process");
  const script = `
    import { pathToFileURL } from "node:url";
    const { __registeredToolsForTest } = await import("./src/mcp-tools/server.ts");
    await import("./src/mcp-tools/index-catalog.ts");
    const tools = __registeredToolsForTest();
    const out = {};
    for (const name of ["get-course", "list-programs"]) {
      const t = tools.find((x) => x.tool.name === name);
      const res = await t.handler({ course: "GC 4061" });
      out[name] = {
        isError: res.isError === true,
        text: String(res.content?.[0]?.text ?? "").slice(0, 220),
      };
    }
    console.log(JSON.stringify(out));
  `;
  const raw = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        CATALOG_DB: path.join(os.tmpdir(), `absent-${process.pid}.db`),
      },
    },
  );
  const out = JSON.parse(raw.trim().split("\n").pop()!) as Record<
    string,
    { isError: boolean; text: string }
  >;

  assert.equal(
    out["get-course"]!.isError,
    true,
    `an unopenable catalog must ERROR, got: ${out["get-course"]!.text}`,
  );
  assert.match(
    out["get-course"]!.text,
    /NOT the same as the course not existing/,
    "and must say so, because the caller cannot tell otherwise",
  );
  assert.equal(
    out["list-programs"]!.isError,
    true,
    `an unopenable catalog must ERROR, not return zero programs, got: ${out["list-programs"]!.text}`,
  );
  assert.match(
    out["list-programs"]!.text,
    /NOT the same as there being no programs/,
  );
});

test("a MISS and an UNREADABLE catalog are different outcomes at the SQL layer", () => {
  // The whole point. getCourseEntry returns null only for "no such course";
  // an unopenable database throws, so the tool can report an error instead of
  // laundering it into found:false. Runs without artifacts.
  const missing = path.join(os.tmpdir(), `nope-${process.pid}.db`);
  assert.ok(!fs.existsSync(missing));
  assert.throws(
    () => new Database(missing, { readonly: true, fileMustExist: true }),
    "an absent catalog must throw, not read as empty",
  );

  // And an EMPTY but valid catalog yields a miss, not a throw — the two states
  // must stay distinguishable in both directions.
  const empty = path.join(os.tmpdir(), `empty-${process.pid}.db`);
  const db = new Database(empty);
  try {
    db.exec(
      "CREATE TABLE course (code TEXT, title TEXT, credits TEXT, description TEXT)",
    );
    assert.equal(getCourseEntry(db, "GC 4061"), null);
  } finally {
    db.close();
    fs.rmSync(empty, { force: true });
  }
});

// --- WIRING: the tools are actually SERVED, and honour their outputSchema ----

test("both tools are registered and reachable through a real MCP client", async () => {
  // The readers above prove the SQL. They prove nothing about the tools being
  // registered, permitted by policy, or named what the advisor will ask for —
  // the class of miss test/mcp-wiring.test.ts exists for.
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  await import("../src/mcp-tools/index-catalog.ts");
  const { __buildServerForTest } = await import("../src/mcp-tools/server.ts");

  const server = __buildServerForTest("advising-mcp-catalog");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "1" }, {});
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(
      names.includes("list-programs"),
      `list-programs missing from ${names.join(", ")}`,
    );
    assert.ok(
      names.includes("get-course"),
      `get-course missing from ${names.join(", ")}`,
    );

    if (skip) return; // the calls below need the catalog DB

    const progs = (await client.callTool({
      name: "list-programs",
      arguments: {},
    })) as {
      isError?: boolean;
      structuredContent?: { catalog_years?: unknown[]; programs?: unknown[] };
    };
    assert.ok(
      !progs.isError,
      "list-programs must not error with a loaded catalog",
    );
    assert.ok(
      Array.isArray(progs.structuredContent?.programs) &&
        progs.structuredContent!.programs!.length > 0,
      "programs must arrive as structured content, not only as text",
    );

    const miss = (await client.callTool({
      name: "get-course",
      arguments: { course: "ZZZZ 9999" },
    })) as {
      isError?: boolean;
      structuredContent?: { found?: boolean; code?: string };
    };
    assert.ok(!miss.isError, "a MISS is a successful call, not an error");
    assert.equal(
      miss.structuredContent?.found,
      false,
      "found must be a typed false",
    );
    assert.equal(
      miss.structuredContent?.code,
      "ZZZZ 9999",
      "and must echo what was looked up",
    );

    const junk = (await client.callTool({
      name: "get-course",
      arguments: { course: "not a course" },
    })) as { isError?: boolean };
    assert.ok(junk.isError, "junk input must fail as junk, never as a miss");
  } finally {
    await client.close();
    await server.close();
  }
});
