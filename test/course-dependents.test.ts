// "What needs GC 3460?" — the downward walk over prerequisite edges
// (2026-10-06). Today the edges are the catalog's flat code lists
// (course.prereq_parsed): they say a course NAMES another in its
// prerequisite, not how (required / one of several / same term), so every
// dependent carries its own prerequisite wording verbatim and nothing is
// labelled. Reviewed rules (prereq_expression) will add labels later.
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { prerequisiteFor } from "../src/course-dependents.ts";
import { catalogFixtureDdl } from "./_catalog-fixture-ddl.ts";

function db() {
  const d = new Database(":memory:");
  d.exec(catalogFixtureDdl("course"));
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
  c("GC 3460", "GC 2070", ["GC 2070"]);
  c("GC 4060", "GC 2070 and GC 3500. Preq or concurrent enrollment: GC 3460", [
    "GC 2070",
    "GC 3500",
    "GC 3460",
  ]);
  c("GC 4400", "GC 2070 and GC 3500. Preq or concurrent enrollment: GC 3460", [
    "GC 2070",
    "GC 3500",
    "GC 3460",
  ]);
  c("GC 4440", "GC 3400 and GC 3500 and GC 4060 and GC 4400", [
    "GC 3400",
    "GC 3500",
    "GC 4060",
    "GC 4400",
  ]);
  c("PKSC 3200", "Both CH 1010 and MATH 1060; or GC 2070; or PKSC 2200", [
    "CH 1010",
    "MATH 1060",
    "GC 2070",
    "PKSC 2200",
  ]);
  // A malformed cycle must not hang the walk.
  c("ZZ 1000", "ZZ 2000", ["ZZ 2000"]);
  c("ZZ 2000", "ZZ 1000", ["ZZ 1000"]);
  return d;
}

test("direct dependents carry their own prerequisite wording", () => {
  const r = prerequisiteFor(db(), "GC 3460");
  assert.deepEqual(
    r.dependents.map((d) => d.code),
    ["GC 4060", "GC 4400"],
  );
  assert.equal(r.total, 2);
  assert.equal(r.truncated, false);
  assert.match(
    r.dependents[0].prereq_text ?? "",
    /concurrent enrollment: GC 3460/,
  );
  assert.equal(r.dependents[0].depth, 1);
});

test("the chain walks further down, with depth and the course it came through", () => {
  const r = prerequisiteFor(db(), "GC 3460", { chain: true });
  const byCode = new Map(r.dependents.map((d) => [d.code, d]));
  assert.equal(byCode.get("GC 4440")?.depth, 2);
  assert.equal(byCode.get("GC 4440")?.via, "GC 4060");
  assert.equal(r.total, 3);
});

test("a course in another department that names it is found", () => {
  const r = prerequisiteFor(db(), "GC 2070");
  assert.ok(r.dependents.some((d) => d.code === "PKSC 3200"));
});

test("a subject filter narrows the answer but not the walk", () => {
  const r = prerequisiteFor(db(), "GC 2070", { chain: true, subject: "pksc" });
  assert.deepEqual(
    r.dependents.map((d) => d.code),
    ["PKSC 3200"],
  );
});

test("a large fan-out is capped, with the true total and truncated:true", () => {
  const r = prerequisiteFor(db(), "GC 2070", { chain: true, limit: 2 });
  assert.equal(r.dependents.length, 2);
  assert.ok(r.total > 2);
  assert.equal(r.truncated, true);
});

test("a cycle in the data does not hang the chain walk", () => {
  const r = prerequisiteFor(db(), "ZZ 1000", { chain: true });
  assert.deepEqual(
    r.dependents.map((d) => d.code),
    ["ZZ 2000"],
  );
});

test("a course nothing names returns zero, stated, not an error", () => {
  const r = prerequisiteFor(db(), "GC 4440");
  assert.equal(r.total, 0);
  assert.deepEqual(r.dependents, []);
});

test("codes are normalized before lookup", () => {
  assert.equal(prerequisiteFor(db(), "gc3460").total, 2);
});
