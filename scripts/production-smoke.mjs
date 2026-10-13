import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = process.cwd();
const projectId = process.env.FLOW_SMOKE_PROJECT_ID;
const jobId = process.env.FLOW_SMOKE_JOB_ID;
const requestedMediaId = process.env.FLOW_SMOKE_MEDIA_ID;
assert.ok(projectId, 'Set FLOW_SMOKE_PROJECT_ID to an existing local project ID');
assert.ok(jobId || requestedMediaId, 'Set FLOW_SMOKE_JOB_ID or FLOW_SMOKE_MEDIA_ID to an existing video');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'src', 'index.js')],
  cwd: root,
  env: process.env,
  stderr: 'pipe',
});
const client = new Client({ name: 'google-flow-studio-production-smoke', version: '1.0.1' });
const call = async (name, args = {}) => {
  const request = { name, arguments: args };
  const deadline = name === 'flow_download_media' ? Date.now() + 300_000 : undefined;
  const pendingMessage = 'The existing Flow download is still processing. Retry downloadMedia with the same parameters to keep waiting; the download will not be submitted again.';
  while (true) {
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw new Error('Flow download exceeded the 300-second smoke limit');
    const result = await client.callTool(request, remaining === undefined ? undefined : { timeout: Math.min(60_000, remaining) });
    if (!result.isError) return result.structuredContent ?? JSON.parse(result.content[0].text);
    if (deadline !== undefined && result.content.some((item) => item.type === 'text' && item.text === pendingMessage)) continue;
    throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  }
};

await client.connect(transport);
try {
  const health = await call('mcp_health_check');
  assert.equal(health.status, 'healthy');
  const project = await call('project_get', { projectId });
  const projectUrl = project.project.flowProjectUrl;
  assert.ok(projectUrl, 'The selected project must already have a linked Flow URL');
  if (process.env.FLOW_SMOKE_PROJECT_URL) assert.equal(projectUrl, process.env.FLOW_SMOKE_PROJECT_URL);
  const job = jobId ? project.jobs.find((item) => item.id === jobId) : undefined;
  if (jobId) {
    assert.ok(job, 'FLOW_SMOKE_JOB_ID must belong to the selected project');
    assert.equal(job.operation, 'video');
    assert.equal(job.state, 'complete');
    assert.ok(job.providerMediaId, 'The selected job must have a saved media ID');
    if (requestedMediaId) assert.equal(requestedMediaId, job.providerMediaId);
  }
  const mediaId = requestedMediaId ?? job.providerMediaId;
  const auth = await call('flow_auth_status');
  assert.equal(auth.status, 'ready', 'Confirm the browser profile login before running smoke');

  await call('flow_open_project', { projectId, projectUrl });
  const page = await call('flow_inspect_page');
  const opened = await call('flow_open_media', { projectId, mediaId });
  assert.equal(opened.media.kind, 'video');
  const outputName = `production-smoke-${Date.now()}.mp4`;
  const downloaded = await call('flow_download_media', {
    projectId, mediaId, destinationDir: health.downloadDir, fileName: outputName, resolution: 'original',
  });
  assert.equal(downloaded.path, path.join(health.downloadDir, outputName));
  assert.ok(downloaded.bytes > 0);
  const validation = await call('media_validate_local', { filePath: downloaded.path });
  assert.equal(validation.valid, true);
  const { stdout } = await promisify(execFile)(health.ffprobe.command, [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+1',
    '-show_frames', '-show_entries', 'frame=width,height', '-of', 'json', downloaded.path,
  ], { timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
  const frames = JSON.parse(stdout).frames ?? [];
  assert.ok(frames.some((frame) => frame.width > 0 && frame.height > 0), 'The downloaded video must decode at least one frame');
  console.log(JSON.stringify({
    health,
    page: { url: page.url, title: page.title },
    media: opened.media,
    downloaded: { path: downloaded.path, bytes: downloaded.bytes },
    validation,
    decodedFrames: frames.length,
  }, null, 2));
} finally {
  await client.close();
}
