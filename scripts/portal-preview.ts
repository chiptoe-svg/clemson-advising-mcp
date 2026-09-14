#!/usr/bin/env -S npx tsx
// Render the reveal page with sample data, for review before anything is served.
//
//   npm run portal:preview            -> writes /tmp/... and prints the path
//   npm run portal:preview -- out.html
//
// The tokens here are OBVIOUSLY FAKE by construction — they carry the word
// SAMPLE and are not valid base64url of the right length. A preview that used
// realistic-looking tokens would be indistinguishable from a real reveal, and
// the whole point of this page is that a real one exists exactly once.
import fs from "fs";
import { renderRevealPage, type Grant } from "../src/portal/reveal-page.js";

// Verbatim from the gc_alumni session, 2026-09-13. Measured, not estimated.
// Do not paraphrase: the numbers are the disclosure.
const DISCLOSURE: Record<string, string> = {
  gc_alumni:
    "This token reads the complete alumni record for 3,135 Clemson Graphic " +
    "Communications graduates: email for 2,162 of them, phone for 2,318, " +
    "Clemson ID (CUID) for 896, plus full job history, LinkedIn profiles and " +
    "photographs. It also returns graduates who asked to be left out of the " +
    "student-facing directory. This is departmental data. Do not paste it into " +
    "anything that leaves Clemson, and do not share this token.",
  gc_careers:
    "This token reads published career data: aggregate graduate outcomes, " +
    "occupation and salary reference, and named graduates at companies and in " +
    "cities. It holds no email, no phone, no Clemson ID and no individual " +
    "salary figures, and it excludes graduates who opted out of the directory.",
};

const grants: Grant[] = [
  {
    server: "cu_schedule",
    label: "Clemson class schedule",
    url: "https://gcworkflow.clemson.edu:8443/cu_schedule/",
    token: "cma_SAMPLE_schedule_not_a_real_token",
    scopeSummary: "class times, sections, enrollment history",
  },
  {
    server: "cu_catalog",
    label: "Clemson degree catalog",
    url: "https://gcworkflow.clemson.edu:8443/cu_catalog/",
    token: "cma_SAMPLE_catalog_not_a_real_token",
    scopeSummary: "program plans, requirements, course descriptions",
  },
  {
    server: "gc_careers",
    label: "GC graduate careers",
    url: "https://gcworkflow.clemson.edu:8443/gc_careers/",
    token: "gc_SAMPLE_careers_not_a_real_token",
    scopeSummary: null,
    disclosure: DISCLOSURE.gc_careers,
  },
  {
    server: "gc_alumni",
    label: "GC alumni records",
    url: "https://gcworkflow.clemson.edu:8443/gc_alumni/",
    token: "gc_SAMPLE_alumni_not_a_real_token",
    // NOT just "research tools". A scope line under that disclosure reads as a
    // limit on what the token can see, and this one is not: `query` is inside
    // gc.alumni.research, so research and full access read identical records.
    // Saying only the scope name here would undo the disclosure above it.
    scopeSummary:
      "research tools (gc.alumni.research) — hides 4 pipeline tools; " +
      "does NOT reduce which records are readable",
    disclosure: DISCLOSURE.gc_alumni,
  },
];

const out = process.argv[2] ?? "/tmp/reveal-preview.html";
fs.writeFileSync(
  out,
  renderRevealPage({
    personName: "Jane Smith",
    grants,
    contact: "Chip Tonkin",
  }),
);
process.stdout.write(`wrote ${out}\n`);
