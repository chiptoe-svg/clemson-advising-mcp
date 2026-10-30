// Credit hours come from the SECTION, not the course's range (2026-10-30).
// Chip asked the advisor how many credits GC 4900 005 Analog Photography was
// and got 1; Banner lists it at 3. GC 4900 is a 1-3 variable-credit course:
// Banner sends the section's own creditHours (3) beside the course's range
// (creditHourLow 1, creditHourHigh 3), and the mapper preferred the low end.
// Fixed-credit sections carry only creditHourLow; a variable-credit section
// whose credits aren't set yet has no single value, so none is claimed.
import assert from "node:assert/strict";
import test from "node:test";

const { mapSection } = await import("../src/clemson-classes.ts");

const base = { courseReferenceNumber: "17152", subjectCourse: "GC4900" };

test("a variable-credit section reports its own credits, not the course minimum", () => {
  const s = mapSection({
    ...base,
    creditHours: 3,
    creditHourLow: 1,
    creditHourHigh: 3,
    creditHourIndicator: "TO",
  });
  assert.equal(s.creditHours, 3);
});

test("a fixed-credit section reports its one value", () => {
  const s = mapSection({
    ...base,
    creditHours: null,
    creditHourLow: 3,
    creditHourHigh: null,
    creditHourIndicator: null,
  });
  assert.equal(s.creditHours, 3);
});

test("a variable-credit section with no credits set claims none", () => {
  const s = mapSection({
    ...base,
    creditHours: null,
    creditHourLow: 1,
    creditHourHigh: 3,
    creditHourIndicator: "TO",
  });
  assert.equal(s.creditHours, null);
});
