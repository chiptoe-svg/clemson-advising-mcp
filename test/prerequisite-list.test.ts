// get-prerequisites: a subject's prerequisite graph in one call, for the
// admin enrollment forecast (Cob_advisor, 2026-10-31). Properties under test:
// a reviewed rule (still valid against its catalog text) wins over the flat
// catalog list and is the only source that can say "concurrent"; a course
// whose wording names no course is listed as unparsed, never as having none.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import Database from "better-sqlite3";

import { listPrerequisites } from "../src/prerequisite-list.ts";
import { catalogFixtureDdl } from "./_catalog-fixture-ddl.ts";

const sha = (s: string) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex");

function db() {
  const d = new Database(":memory:");
  d.exec(catalogFixtureDdl("course"));
  d.exec(
    "CREATE TABLE prereq_expression (code TEXT PRIMARY KEY, expr TEXT NOT NULL, source_text_hash TEXT NOT NULL, note TEXT)",
  );
  const add = d.prepare(
    "INSERT INTO course (code, subject, number, title, prereq_text, prereq_parsed) VALUES (?,?,?,?,?,?)",
  );
  const c = (code: string, text: string | null, codes: string[]) => {
    const [s, n] = code.split(" ");
    add.run(
      code,
      s,
      n,
      `${code} title`,
      text,
      codes.length ? JSON.stringify(codes) : null,
    );
  };
  const rule = d.prepare("INSERT INTO prereq_expression VALUES (?,?,?,?)");
  c("GC 1010", null, []);
  const t2070 =
    "Graphic Communications major and GC 1010 and GC 1020 and GC 1040";
  c("GC 2070", t2070, ["GC 1010", "GC 1020", "GC 1040"]);
  rule.run(
    "GC 2070",
    "[major:Graphic Communications] & GC 1010 & GC 1020 & GC 1040 & GC 1050",
    sha(t2070),
    "Correction: GC 1050 also required",
  );
  const t4060 = "GC 2070 and GC 3500. Preq or concurrent enrollment: GC 3460";
  c("GC 4060", t4060, ["GC 2070", "GC 3500", "GC 3460"]);
  rule.run("GC 4060", "GC 2070 & GC 3500 & ~GC 3460", sha(t4060), null);
  // A stale review (catalog text changed since): the catalog list is used.
  c("GC 4400", "GC 3400 or GC 3500", ["GC 3400", "GC 3500"]);
  rule.run("GC 4400", "GC 9999", sha("older wording"), null);
  c("GC 4900", "Consent of instructor", []);
  c("PKSC 3200", "GC 2070 or PKSC 2200", ["GC 2070", "PKSC 2200"]);
  return d;
}

test("a subject comes back whole, sorted, with each course's source", () => {
  const r = listPrerequisites(db(), { subject: "GC" });
  assert.deepEqual(
    r.courses.map((c) => c.course),
    ["GC 1010", "GC 2070", "GC 4060", "GC 4400", "GC 4900"],
  );
  const by = new Map(r.courses.map((c) => [c.course, c]));
  assert.equal(by.get("GC 1010")!.source, "none");
  assert.deepEqual(by.get("GC 1010")!.prerequisites, []);
  assert.deepEqual(r.unparsed, ["GC 4900"]);
});

test("a reviewed rule wins: concurrent split out, conditions under other, the rule and note kept", () => {
  const by = new Map(
    listPrerequisites(db(), { subject: "GC" }).courses.map((c) => [
      c.course,
      c,
    ]),
  );
  const g4060 = by.get("GC 4060")!;
  assert.equal(g4060.source, "expression");
  assert.deepEqual(g4060.prerequisites, ["GC 2070", "GC 3500"]);
  assert.deepEqual(g4060.concurrent, ["GC 3460"]);
  assert.equal(g4060.rule, "GC 2070 & GC 3500 & ~GC 3460");
  const g2070 = by.get("GC 2070")!;
  assert.deepEqual(g2070.prerequisites, [
    "GC 1010",
    "GC 1020",
    "GC 1040",
    "GC 1050",
  ]);
  assert.deepEqual(g2070.other, ["major: Graphic Communications"]);
  assert.match(g2070.review_note ?? "", /GC 1050/);
});

test("without a current review, the catalog's codes and wording, and no concurrent claim", () => {
  const by = new Map(
    listPrerequisites(db(), { subject: "GC" }).courses.map((c) => [
      c.course,
      c,
    ]),
  );
  const g4400 = by.get("GC 4400")!;
  assert.equal(g4400.source, "text");
  assert.deepEqual(g4400.prerequisites, ["GC 3400", "GC 3500"]);
  assert.equal(g4400.prereq_text, "GC 3400 or GC 3500");
  assert.equal(g4400.concurrent, undefined);
});

test("courses select specific codes across subjects; unknown ones are named", () => {
  const r = listPrerequisites(db(), {
    courses: ["pksc3200", "GC 4060", "GC 1234"],
  });
  assert.deepEqual(
    r.courses.map((c) => c.course),
    ["GC 4060", "PKSC 3200"],
  );
  assert.deepEqual(r.unknown_courses, ["GC 1234"]);
});
