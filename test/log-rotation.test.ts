import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log, __configureLogForTest, __resetLogForTest } from "../src/log.ts";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "log-rot-")), "app.log");
}

test("unset LOG_FILE writes to the stderr sink only", () => {
  const lines: string[] = [];
  __configureLogForTest({ sink: (l) => lines.push(l) });
  log.info("hello", { a: 1 });
  __resetLogForTest();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[info\] hello \{"a":1\}\n$/);
});

test("LOG_FILE appends and rotates at maxBytes, keeping LOG_KEEP files", () => {
  const file = tmpFile();
  __configureLogForTest({ file, maxBytes: 200, keep: 2 });
  for (let i = 0; i < 40; i++) log.info("x".repeat(20), { i });
  __resetLogForTest();
  assert.ok(fs.existsSync(file), "live file exists");
  assert.ok(fs.statSync(file).size <= 200 + 64, "live file stays near the cap");
  assert.ok(fs.existsSync(file + ".1"), "first rotated file exists");
  assert.ok(fs.existsSync(file + ".2"), "second rotated file exists");
  assert.ok(!fs.existsSync(file + ".3"), "keep bound honoured");
});

test("a rotation shifts .1 to .2 and never loses the newest lines", () => {
  const file = tmpFile();
  __configureLogForTest({ file, maxBytes: 120, keep: 3 });
  log.info("first-batch");
  log.info("y".repeat(150)); // forces rotation on the NEXT write
  log.info("after-rotation");
  __resetLogForTest();
  const all = [file, file + ".1", file + ".2"].filter(fs.existsSync).map((f) => fs.readFileSync(f, "utf8")).join("");
  assert.match(all, /first-batch/);
  assert.match(all, /after-rotation/);
});

test("a throwing sink never escapes emit()", () => {
  __configureLogForTest({
    sink: () => {
      throw new Error("broken");
    },
  });
  assert.doesNotThrow(() => log.info("x"));
  __resetLogForTest();
});
