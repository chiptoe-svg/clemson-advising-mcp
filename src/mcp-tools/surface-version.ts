// Surface versioning — "is the skill document you cached still current?"
//
// WHY (owner, 2026-08-27): a client is meant to fetch the skill document once
// and reuse it. That only works if it can tell when its copy went stale.
// Nothing in MCP tells a client "the docs you cached have changed", so the
// server has to say so, on a channel the client sees without asking.
//
// The channel is `_meta` on every tool result. A client that cached a skill doc
// compares the version it holds against the one riding on every response it is
// already receiving; no extra round trip, no new tool, and no client change
// required for the information to be *available*. Clients that ignore it are
// exactly as well off as before.
//
// COST CONTROL: recomputing a content hash of every skill file on every tool
// call would be absurd. The version is cached and re-derived only when a cheap
// stat sweep (path + mtime + size) shows something changed, so the steady state
// is a handful of stat() calls, and the expensive read happens only after an
// actual edit.

import crypto from "crypto";
import fs from "fs";
import path from "path";

/** Recursively collect *.md paths under a root, sorted for a stable digest. */
function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an absent skill root is not an error — it contributes nothing
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Cheap change detector: path + mtime + size for every skill file. */
function statSignature(roots: readonly string[]): string {
  const parts: string[] = [];
  for (const root of roots) {
    for (const f of markdownFiles(root)) {
      try {
        const st = fs.statSync(f);
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        /* raced with a delete; the next call will settle it */
      }
    }
  }
  return parts.join("\n");
}

/** Content digest — the value actually reported. */
function contentVersion(roots: readonly string[]): string {
  const h = crypto.createHash("sha256");
  for (const root of roots) {
    for (const f of markdownFiles(root)) {
      try {
        h.update(f, "utf-8");
        h.update(fs.readFileSync(f));
      } catch {
        /* skip unreadable */
      }
    }
  }
  return h.digest("hex").slice(0, 12);
}

let cachedSignature: string | null = null;
let cachedVersion = "unknown";

/**
 * Current skills version — a short content digest that changes when, and only
 * when, the skill documents' CONTENT changes. Touching a file without editing it
 * re-runs the digest but yields the same value, so clients are not churned by a
 * `git checkout`.
 */
export function skillsVersion(roots: readonly string[]): string {
  const sig = statSignature(roots);
  if (sig !== cachedSignature) {
    cachedSignature = sig;
    cachedVersion = contentVersion(roots);
  }
  return cachedVersion;
}

/** Drop the cache (tests, and any future explicit reload path). */
export function __resetSkillsVersionCache(): void {
  cachedSignature = null;
  cachedVersion = "unknown";
}

// ROOTS ARE REGISTERED, NOT IMPORTED. server.ts needs the skills version on
// every tool result, but skills.ts imports registerTools from server.ts — so
// server.ts importing skills.ts closes a cycle and `toolMap` is read before
// initialisation (observed: 24 suites failing with "Cannot access 'toolMap'
// before initialization"). This module imports nothing of ours, skills.ts
// registers its roots here at import time, and server.ts depends only on this.
let rootsProvider: () => readonly string[] = () => [];

/** Called by skills.ts at import time so this module never has to import it. */
export function setSkillRootsProvider(fn: () => readonly string[]): void {
  rootsProvider = fn;
}

/** The skills version for the roots this process actually serves. */
export function currentSkillsVersion(): string {
  return skillsVersion(rootsProvider());
}

/** The `_meta` key carrying the skills version on every tool result. */
export const SKILLS_VERSION_META_KEY = "cuassistant/skillsVersion";
/** The `_meta` key naming the tool that returns the current document. */
export const SKILLS_DOC_TOOL_META_KEY = "cuassistant/skillsDocTool";
