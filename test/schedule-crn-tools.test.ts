// get-sections-by-crn and resolve-crns (2026-08-28).
//
// These exist so the advisor's host-side confirmation that a model-proposed CRN
// is real can run over MCP instead of opening state/clemson/<term>.db directly.
// That check is what stops a fabricated CRN reaching a printed document, so the
// behaviour that matters here is not "does it return rows" — it is that absence
// is REPORTED rather than implied, in all three of its forms:
//
//   a CRN the snapshot does not have     -> not_found, authoritative
//   a term with no snapshot at all       -> has_snapshot:false, nothing claimed
//   two sections matching one course     -> null, never a guess

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { getSectionsByCrn, resolveCrns } from "../src/clemson-schedule-db.ts";

function fixture(): { db: Database.Database; path: string } {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "crn-tools-")),
    "snap.db",
  );
  const db = new Database(p);
  db.exec(`
    CREATE TABLE sections (
      term TEXT, crn TEXT, subject_course TEXT, section TEXT, title TEXT, credit_hours REAL
    );
    CREATE TABLE meetings (
      term TEXT, crn TEXT, day TEXT, start_min INTEGER, end_min INTEGER,
      building TEXT, room TEXT
    );
    INSERT INTO sections VALUES
      ('202608','80773','GC1040','001','Graphic Communications I',4.0),
      ('202608','80771','GC1020','001','Intro to Digital Graphics',2.0),
      ('202608','80900','GC3400','001','Dup A',3.0),
      ('202608','80901','GC3400','001','Dup B',3.0),
      ('202608','80902','GC5000','002','No Credit Recorded',NULL);
    INSERT INTO meetings VALUES
      ('202608','80773','T',750,825,'Godfrey Hall','201'),
      ('202608','80773','R',750,825,'Godfrey Hall','201');
  `);
  return { db, path: p };
}

test("a CRN the snapshot lacks is REPORTED, not merely absent", () => {
  // The whole point. A fabricated CRN returning no row would be
  // indistinguishable from a section with no meetings.
  const { db } = fixture();
  try {
    const r = getSectionsByCrn(db, "202608", ["80773", "99999"]);
    assert.deepEqual(r.notFound, ["99999"]);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0]!.crn, "80773");
  } finally {
    db.close();
  }
});

test("a section with NO meetings is distinct from a CRN that does not exist", () => {
  const { db } = fixture();
  try {
    const r = getSectionsByCrn(db, "202608", ["80771", "99999"]);
    assert.deepEqual(r.notFound, ["99999"], "only the fake CRN is not-found");
    const async_ = r.sections.find((s) => s.crn === "80771");
    assert.ok(async_, "an async section EXISTS");
    assert.deepEqual(async_!.meetings, [], "it simply has no meetings");
  } finally {
    db.close();
  }
});

test("rows carry every field the verifier compares, including title", () => {
  // title was missed on the first pass and only surfaced because a caller
  // rebuilds a full section from these rows.
  const { db } = fixture();
  try {
    const s = getSectionsByCrn(db, "202608", ["80773"]).sections[0]!;
    assert.equal(s.subject_course, "GC1040");
    assert.equal(s.section, "001");
    assert.equal(s.title, "Graphic Communications I");
    assert.equal(s.credit_hours, 4);
    assert.equal(s.meetings.length, 2);
    assert.deepEqual(
      s.meetings.map((m) => m.day).sort(),
      ["R", "T"],
    );
    assert.equal(s.meetings[0]!.building, "Godfrey Hall");
  } finally {
    db.close();
  }
});

test("a null credit_hours stays null — unknown is not zero", () => {
  const { db } = fixture();
  try {
    const s = getSectionsByCrn(db, "202608", ["80902"]).sections[0]!;
    assert.equal(s.credit_hours, null, "null must not be coerced to 0, which is a claim");
  } finally {
    db.close();
  }
});

test("duplicate CRNs collapse, and results keep the requested order", () => {
  const { db } = fixture();
  try {
    const r = getSectionsByCrn(db, "202608", ["80771", "80773", "80771"]);
    assert.deepEqual(r.sections.map((s) => s.crn), ["80771", "80773"]);
  } finally {
    db.close();
  }
});

test("resolveCrns matches spaceless and spaced course codes alike", () => {
  const { db } = fixture();
  try {
    assert.deepEqual(
      resolveCrns(db, "202608", [
        { subjectCourse: "GC 1040", section: "001" },
        { subjectCourse: "gc1020", section: "001" },
      ]),
      ["80773", "80771"],
    );
  } finally {
    db.close();
  }
});

test("resolveCrns returns null for AMBIGUOUS, never a guess", () => {
  // Two sections share GC3400-001 in this fixture. Picking either would
  // silently place a student in a class they may not be in.
  const { db } = fixture();
  try {
    const out = resolveCrns(db, "202608", [
      { subjectCourse: "GC3400", section: "001" },
      { subjectCourse: "GC9999", section: "001" },
    ]);
    assert.equal(out[0], null, "ambiguous must be null");
    assert.equal(out[1], null, "no match must be null");
  } finally {
    db.close();
  }
});

test("resolveCrns results stay aligned BY INDEX with the input", () => {
  // A short or reordered array would shift every row of a student's schedule.
  const { db } = fixture();
  try {
    const out = resolveCrns(db, "202608", [
      { subjectCourse: "GC9999", section: "001" },
      { subjectCourse: "GC 1040", section: "001" },
      { subjectCourse: "GC3400", section: "001" },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out, [null, "80773", null]);
  } finally {
    db.close();
  }
});

test("both tools are registered and served", async () => {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  await import("../src/mcp-tools/index-public.ts");
  const { __buildServerForTest } = await import("../src/mcp-tools/server.ts");

  const server = __buildServerForTest("cuassistant-public");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "1" }, {});
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["get-sections-by-crn", "resolve-crns"]) {
      assert.ok(names.includes(n), `${n} missing from ${names.join(", ")}`);
    }
    // A term with no snapshot must not report every CRN as fake.
    const res = (await client.callTool({
      name: "get-sections-by-crn",
      arguments: { term: "209999", crns: ["80773"] },
    })) as { structuredContent?: Record<string, unknown> };
    assert.equal(res.structuredContent?.has_snapshot, false);
    assert.deepEqual(
      res.structuredContent?.not_found,
      [],
      "no snapshot means NOTHING was checked — not that the CRN is fake",
    );
  } finally {
    await client.close();
    await server.close();
  }
});
