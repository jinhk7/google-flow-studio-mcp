import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = process.cwd();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'src', 'index.js')],
  cwd: root,
  env: process.env,
  stderr: 'pipe',
});
const client = new Client({ name: 'google-flow-studio-health-check', version: '1.0.0' });
await client.connect(transport);
try {
  const result = await client.callTool({ name: 'mcp_health_check', arguments: {} });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const health = result.structuredContent ?? JSON.parse(result.content[0].text);
  console.log(JSON.stringify(health, null, 2));
  if (health.status !== 'healthy') process.exitCode = 1;
} finally { await client.close(); }
