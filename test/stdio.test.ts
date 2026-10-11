import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio client discovers the expected MCP tools", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-stdio-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/src/index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: { FLOW_DATA_DIR: directory },
  });
  const client = new Client({ name: "google-flow-studio-mcp-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const expected of [
      "project_create",
      "flow_start_login",
      "flow_confirm_login",
      "flow_inspect_page",
      "flow_download_asset",
      "flow_download_media",
      "flow_bind_asset",
      "flow_open_project",
      "flow_open_media",
      "flow_prepare_generation",
      "flow_submit_generation",
      "flow_wait_for_generation",
      "mcp_health_check",
      "media_validate_local",
      "state_backup",
    ]) {
      assert.ok(names.has(expected), `missing tool: ${expected}`);
    }
    assert.equal(tools.length, 22);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.ok(byName.get("project_create")?.inputSchema.properties?.finalVideoResolution);
    assert.ok(byName.get("flow_prepare_generation")?.inputSchema.properties?.generationResolution);
    assert.ok(byName.get("flow_download_media")?.inputSchema.properties?.resolution);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
