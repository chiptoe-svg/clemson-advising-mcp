// test/mcp-tool-category.test.ts — proves the category survives tools/list
// through the real SDK client (zod parsing), which is the property the
// advisor's derived catalogue depends on.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_CATEGORY_META_KEY } from "../src/mcp-tools/types.ts";
import {
  registerTools,
  __registeredToolsForTest,
} from "../src/mcp-tools/server.ts";
import "../src/mcp-tools/index-schedule.ts";

test("a registered tool's category round-trips through client.listTools() as _meta", async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "t", version: "0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: __registeredToolsForTest()
      .filter((t) => t.tool.name === "search-classes")
      .map((t) => t.tool),
  }));
  await server.connect(serverT);
  const client = new Client({ name: "c", version: "0" }, { capabilities: {} });
  await client.connect(clientT);
  const listed = await client.listTools();
  const tool = listed.tools.find((t) => t.name === "search-classes");
  assert.ok(
    tool,
    "search-classes registered (import the public barrel in this test)",
  );
  assert.equal(
    (tool!._meta as Record<string, unknown>)[TOOL_CATEGORY_META_KEY],
    "core",
  );
  await client.close();
  await server.close();
});

test("registerTools refuses a definition without a category", () => {
  const before = __registeredToolsForTest().length;
  registerTools([
    {
      operation: "clemson.search_classes",
      tool: { name: "no-cat", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ content: [] }),
    } as never,
  ]);
  assert.equal(__registeredToolsForTest().length, before);
});
