// Skills-version staleness signalling (2026-08-27, owner request).
//
// A client is meant to fetch the skill document once and reuse it. That only
// works if it can tell when its copy went stale. Nothing in MCP notifies a
// client that documents changed, so the server stamps a content digest on every
// tool result's `_meta`; the client compares it against the version it holds.
//
// These tests pin the two properties that make it usable: it changes when
// CONTENT changes, and it does NOT change otherwise (a version that churns on
// every touch would train clients to ignore it).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SKILLS_DOC_TOOL_META_KEY,
  SKILLS_VERSION_META_KEY,
  skillsVersion,
  __resetSkillsVersionCache,
} from "../src/mcp-tools/surface-version.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skills-version-"));
}

test("version is stable across calls when nothing changes", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "SKILL.md"), "# one\n");
  __resetSkillsVersionCache();
  const a = skillsVersion([root]);
  const b = skillsVersion([root]);
  assert.equal(a, b);
  assert.notEqual(a, "unknown");
  fs.rmSync(root, { recursive: true, force: true });
});

test("version CHANGES when a skill document's content changes", () => {
  const root = tmpRoot();
  const f = path.join(root, "SKILL.md");
  fs.writeFileSync(f, "# one\n");
  __resetSkillsVersionCache();
  const before = skillsVersion([root]);
  fs.writeFileSync(f, "# one, revised\n");
  const after = skillsVersion([root]);
  assert.notEqual(before, after, "an edited skill doc must invalidate client caches");
  fs.rmSync(root, { recursive: true, force: true });
});

test("version does NOT change when a file is touched but not edited", () => {
  // A version that churns on `git checkout` would be re-fetched constantly and
  // clients would learn to ignore it. Stat detects the touch; the content
  // digest is what is reported.
  const root = tmpRoot();
  const f = path.join(root, "SKILL.md");
  fs.writeFileSync(f, "# stable\n");
  __resetSkillsVersionCache();
  const before = skillsVersion([root]);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(f, later, later);
  assert.equal(skillsVersion([root]), before, "touching without editing must not churn");
  fs.rmSync(root, { recursive: true, force: true });
});

test("version covers nested includes, not just top-level SKILL.md", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "includes"), { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), "# top\n");
  const inc = path.join(root, "includes", "extra.md");
  fs.writeFileSync(inc, "# a\n");
  __resetSkillsVersionCache();
  const before = skillsVersion([root]);
  fs.writeFileSync(inc, "# b\n");
  assert.notEqual(skillsVersion([root]), before, "an edited include must count");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a missing skill root contributes nothing rather than throwing", () => {
  __resetSkillsVersionCache();
  assert.doesNotThrow(() => skillsVersion(["/nonexistent/skills"]));
});

test("the _meta keys are namespaced so they cannot collide with a tool's own keys", () => {
  assert.match(SKILLS_VERSION_META_KEY, /^cuassistant\//);
  assert.match(SKILLS_DOC_TOOL_META_KEY, /^cuassistant\//);
});
