import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { FlowBrowserAdapter } from "../src/flow-adapter.js";
import { createGoogleFlowServer } from "../src/server.js";
import type { JobRecord, PageInspection, ProjectRecord } from "../src/types.js";

test("Flow accepts current and legacy official project routes", () => {
  const validate = FlowBrowserAdapter.prototype["validateFlowProjectUrl"];
  const projectId = "11111111-1111-4111-8111-111111111111";

  for (const url of [
    `https://flow.google.com/project/${projectId}`,
    `https://labs.google/fx/tools/flow/project/${projectId}`,
  ]) {
    assert.doesNotThrow(() => validate(url), url);
  }

  for (const url of [
    "https://flow.google.com/",
    "https://flow.google.com/project/",
    `https://labs.google/project/${projectId}`,
    `https://flow.google.com/fx/tools/flow/project/${projectId}`,
    `http://flow.google.com/project/${projectId}`,
    `https://example.com/project/${projectId}`,
  ]) {
    assert.throws(() => validate(url), /Only official Google Flow project URLs are allowed/, url);
  }
});

test("MCP server can be constructed without launching a browser", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "google-flow-mcp-server-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const instance = createGoogleFlowServer({
    browserExecutable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    profileDir: path.join(directory, "profile"),
    stateFile: path.join(directory, "state.json"),
  });

  assert.ok(instance.server);
  assert.ok(instance.store);
  await instance.flow.close();
  instance.store.close();
});

async function routingFixture(t: TestContext, finalVideoResolution?: "720p" | "1080p") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "google-flow-routing-test-"));
  const instance = createGoogleFlowServer({
    browserExecutable: "unused-browser",
    profileDir: path.join(directory, "profile"),
    stateFile: path.join(directory, "state.json"),
    downloadDir: directory,
  });
  const projectUrl = "https://flow.google.com/project/11111111-1111-4111-8111-111111111111";
  const page: PageInspection = {
    url: projectUrl, title: "Film", visibleText: "", buttons: [], textboxes: [],
    fileInputCount: 0, media: [], failureCount: 0,
  };
  const observed = {
    browserActions: [] as string[],
    configured: [] as string[],
    clicked: 0,
    currentResolution: undefined as "360p" | "720p" | undefined,
    downloads: [] as Parameters<FlowBrowserAdapter["downloadMedia"]>[0][],
    mediaKind: "video" as "image" | "video",
  };
  instance.flow.inspectPage = async () => { observed.browserActions.push("inspect"); return page; };
  instance.flow.fillTextbox = async () => { observed.browserActions.push("fill"); return page; };
  instance.flow.configureVideoResolution = async (resolution) => {
    observed.browserActions.push("configure");
    observed.configured.push(resolution);
    observed.currentResolution = resolution;
    return resolution;
  };
  instance.flow.inspectVideoResolution = async () => {
    observed.browserActions.push("inspect-resolution");
    return observed.currentResolution;
  };
  instance.flow.clickControl = async () => {
    observed.browserActions.push("click"); observed.clicked += 1; return page;
  };
  instance.flow.downloadMedia = async (input) => {
    observed.downloads.push(input);
    const downloadPath = path.join(directory, input.fileName ?? `${observed.downloads.length}.mp4`);
    await writeFile(downloadPath, "local download fixture");
    return {
      path: downloadPath, suggestedFileName: path.basename(downloadPath), sourceUrl: projectUrl, bytes: 22,
      media: {
        tileId: input.mediaId ?? "downloaded-media", title: input.title ?? "Film shot",
        kind: observed.mediaKind, href: `${projectUrl}/edit/${input.mediaId ?? "downloaded-media"}`,
      },
      downloadedResolution: observed.mediaKind === "image" ? undefined : input.resolution === "1080p" ? "1080p" : "720p",
      downloadVariant: observed.mediaKind === "image" || input.resolution === "original" ? "original" : "upscaled",
    };
  };
  const client = new Client({ name: "routing-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close(); await instance.server.close(); await instance.flow.close();
    instance.store.close(); await rm(directory, { recursive: true, force: true });
  });
  const raw = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return result.structuredContent as T;
  };
  const project = await call<ProjectRecord>("project_create", {
    title: "Film", brief: "A park bench in winter", language: "en-US", finalVideoResolution,
  });
  await instance.store.update((state) => {
    state.auth.status = "ready";
    state.auth.freshLoginForProjectId = project.id;
    state.projects[0].flowProjectUrl = projectUrl;
  });
  const prepare = (args: Record<string, unknown> = {}) => call<{ job: JobRecord; reused: boolean }>("flow_prepare_generation", {
    projectId: project.id, operation: "video", shotIndex: 1, prompt: "The man rubs his hands.",
    textboxLabel: "Flow prompt", ...args,
  });
  return { ...instance, project, observed, call, raw, prepare };
}

for (const [target, generation] of [["720p", "360p"], ["1080p", "720p"]] as const) {
  test(`MCP routes final ${target} through ${generation} and stores the job settings`, async (t) => {
    const fixture = await routingFixture(t, target);
    const prepared = await fixture.prepare();
    assert.equal(fixture.project.finalVideoResolution, target);
    assert.equal(prepared.job.finalVideoResolution, target);
    assert.equal(prepared.job.generationResolution, generation);
    assert.deepEqual(fixture.observed.configured, [generation]);
    assert.equal(prepared.job.state, "prepared");
  });
}

test("MCP asks for a video target before browser actions or creating a job", async (t) => {
  const fixture = await routingFixture(t);
  const result = await fixture.raw("flow_prepare_generation", {
    projectId: fixture.project.id, operation: "video", shotIndex: 1,
    prompt: "The man rubs his hands.", textboxLabel: "Flow prompt",
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /ask.*user/i);
  assert.deepEqual(fixture.observed.browserActions, []);
  assert.equal((await fixture.store.read()).jobs.length, 0);
});

test("the first explicit video target becomes the project default", async (t) => {
  const fixture = await routingFixture(t);
  await fixture.prepare({ finalVideoResolution: "1080p" });
  const next = await fixture.prepare({ shotIndex: 2 });
  assert.equal((await fixture.store.read()).projects[0].finalVideoResolution, "1080p");
  assert.equal(next.job.finalVideoResolution, "1080p");
  assert.equal(next.job.generationResolution, "720p");
});

test("1080p delivery rejects a 360p generation override before browser actions", async (t) => {
  const fixture = await routingFixture(t, "1080p");
  const result = await fixture.raw("flow_prepare_generation", {
    projectId: fixture.project.id, operation: "video", shotIndex: 1,
    prompt: "The man rubs his hands.", textboxLabel: "Flow prompt", generationResolution: "360p",
  });
  assert.equal(result.isError, true);
  assert.deepEqual(fixture.observed.browserActions, []);
  assert.equal((await fixture.store.read()).jobs.length, 0);
});

test("reusing a shot preserves its generation override and rejects conflicting settings", async (t) => {
  const fixture = await routingFixture(t, "720p");
  const first = await fixture.prepare({ generationResolution: "720p" });
  await fixture.store.update((state) => { state.projects[0].finalVideoResolution = "1080p"; });
  const reused = await fixture.prepare();
  assert.equal(reused.reused, true);
  assert.equal(reused.job.id, first.job.id);
  assert.equal(reused.job.finalVideoResolution, "720p");
  assert.equal(reused.job.generationResolution, "720p");
  const actionCount = fixture.observed.browserActions.length;
  for (const settings of [{ finalVideoResolution: "1080p" }, { generationResolution: "360p" }]) {
    const result = await fixture.raw("flow_prepare_generation", {
      projectId: fixture.project.id, operation: "video", shotIndex: 1,
      prompt: "The man rubs his hands.", textboxLabel: "Flow prompt", ...settings,
    });
    assert.equal(result.isError, true);
  }
  assert.equal(fixture.observed.browserActions.length, actionCount);
  assert.equal((await fixture.store.read()).jobs.length, 1);
});

test("submit rejects changed UI resolution without clicking or failing the prepared job", async (t) => {
  const fixture = await routingFixture(t, "720p");
  const prepared = await fixture.prepare();
  fixture.observed.currentResolution = "720p";
  const result = await fixture.raw("flow_submit_generation", {
    jobId: prepared.job.id, buttonLabel: "开始生成", userApprovedCreditSpend: true,
  });
  assert.equal(result.isError, true);
  assert.equal(fixture.observed.clicked, 0);
  assert.equal((await fixture.store.read()).jobs[0].state, "prepared");
});

test("submit rejects legacy prepared video jobs with no resolution snapshot", async (t) => {
  const fixture = await routingFixture(t, "720p");
  const { job } = await fixture.store.createJob({
    projectId: fixture.project.id, operation: "video", idempotencyKey: `${fixture.project.id}:video:1:1`,
  });
  await fixture.store.updateJob(job.id, { state: "prepared" });
  const result = await fixture.raw("flow_submit_generation", {
    jobId: job.id, buttonLabel: "开始生成", userApprovedCreditSpend: true,
  });
  assert.equal(result.isError, true);
  assert.equal(fixture.observed.clicked, 0);
  assert.equal((await fixture.store.read()).jobs[0].state, "prepared");
});

test("submit clicks once when the UI resolution matches the prepared job", async (t) => {
  const fixture = await routingFixture(t, "1080p");
  const prepared = await fixture.prepare();
  const submitted = await fixture.call<{ job: JobRecord }>("flow_submit_generation", {
    jobId: prepared.job.id, buttonLabel: "开始生成", userApprovedCreditSpend: true,
  });
  assert.equal(fixture.observed.clicked, 1);
  assert.equal(submitted.job.state, "submitted");
});

test("downloads inherit the job target, direct media inherits the project, and explicit original is honored", async (t) => {
  const fixture = await routingFixture(t, "720p");
  const prepared = await fixture.prepare();
  await fixture.store.updateJob(prepared.job.id, { state: "submitted" });
  await fixture.store.updateJob(prepared.job.id, { state: "complete", providerMediaId: "video-one" });
  await fixture.store.update((state) => { state.projects[0].finalVideoResolution = "1080p"; });
  await fixture.call("flow_download_media", { projectId: fixture.project.id, jobId: prepared.job.id });
  const downloaded = (await fixture.store.read()).jobs[0];
  assert.equal(downloaded.downloadedResolution, "720p");
  assert.equal(downloaded.downloadVariant, "upscaled");
  await fixture.call("flow_download_media", { projectId: fixture.project.id, mediaId: "video-two" });
  await fixture.call("flow_download_media", { projectId: fixture.project.id, title: "Another video" });
  await fixture.call("flow_download_media", { projectId: fixture.project.id, jobId: prepared.job.id, resolution: "original" });
  assert.deepEqual(fixture.observed.downloads.map((input) => input.resolution), ["720p", "1080p", "1080p", "original"]);
  assert.ok((await fixture.store.read()).jobs[0].downloadPath);
});

test("image preparation and download use original images without a video target", async (t) => {
  const fixture = await routingFixture(t);
  const prepared = await fixture.prepare({ operation: "image" });
  assert.deepEqual(fixture.observed.configured, []);
  assert.equal(prepared.job.finalVideoResolution, undefined);
  assert.equal(prepared.job.generationResolution, undefined);
  await fixture.store.updateJob(prepared.job.id, { state: "submitted" });
  await fixture.store.updateJob(prepared.job.id, { state: "complete", providerMediaId: "image-one" });
  await fixture.store.update((state) => { state.projects[0].finalVideoResolution = "1080p"; });
  fixture.observed.mediaKind = "image";
  await fixture.call("flow_download_media", { projectId: fixture.project.id, jobId: prepared.job.id });
  assert.ok([undefined, "original"].includes(fixture.observed.downloads[0].resolution));
});
