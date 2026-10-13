#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createGoogleFlowServer } from "./server.js";

const config = loadConfig();
let activeFlow: ReturnType<typeof createGoogleFlowServer>["flow"] | undefined;
let activeStore: ReturnType<typeof createGoogleFlowServer>["store"] | undefined;

const handle = serveStdio(() => {
  const instance = createGoogleFlowServer(config);
  activeFlow = instance.flow;
  activeStore = instance.store;
  return instance.server;
});

console.error("Google Flow Studio MCP 1.0.1 running on stdio");

async function shutdown() {
  await activeFlow?.close();
  activeStore?.close();
  await handle.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
