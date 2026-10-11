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
const client = new Client({ name: 'google-flow-studio-state-backup', version: '1.0.0' });
await client.connect(transport);
try {
  const result = await client.callTool({ name: 'state_backup', arguments: {} });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
} finally { await client.close(); }
