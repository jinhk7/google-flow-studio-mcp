import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { Config } from "./config.js";
import { FlowBrowserAdapter } from "./flow-adapter.js";
import { sha256File, validateMedia } from "./media-validator.js";
import { StateStore } from "./state.js";
import type { JobRecord } from "./types.js";

function assertNoUnresolvedShot(jobs: JobRecord[], idempotencyKey: string, exceptJobId?: string) {
  const shotKey = idempotencyKey.slice(0, idempotencyKey.lastIndexOf(":"));
  const unresolved = jobs.find((job) => job.id !== exceptJobId
    && job.idempotencyKey.slice(0, job.idempotencyKey.lastIndexOf(":")) === shotKey
    && ["submitted", "generating", "paused"].includes(job.state));
  if (unresolved) throw new Error(`This shot has an unresolved job ${unresolved.id}. Continue observing that job or verify its actual completion/failure in Flow before creating another version. A polling timeout does not prove failure; no new generation was submitted.`);
}

function response(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createGoogleFlowServer(config: Config) {
  const startedAt = new Date().toISOString();
  const store = new StateStore(config.databaseFile ?? config.stateFile, config.stateFile);
  const flow = new FlowBrowserAdapter(config, store);
  const server = new McpServer(
    { name: "google-flow-studio-mcp", version: "1.0.1" },
    {
      instructions: [
        "Reuse existing local projects from project_list/project_get; use project_create only for a new local project.",
        "Check flow_auth_status and reuse a ready browser session across projects and resumptions. Do not restart login merely because a project or conversation changed.",
        "If login is required, call flow_start_login once and wait for the user to sign in personally and close the login Chrome window. When the user says login is complete, call flow_confirm_login directly; polling auth status cannot record the user's confirmation. Do not call flow_start_login again while awaiting that confirmation.",
        "Never ask for, read, type, store, or repeat passwords, verification codes, recovery answers, or 2FA tokens.",
        "Call flow_inspect_page before filling or clicking controls.",
        "Generation submission requires explicit user approval because it may spend credits.",
        "Before preparing video, establish the user's final delivery resolution: 720p or 1080p. Ask only if neither the request nor the saved project specifies it.",
        "Default to 360p generation for a 720p deliverable and 720p generation for a 1080p deliverable, then download the matching free upscaled option offered by Flow. Keep generation and delivery resolution distinct.",
        "Use flow_prepare_generation and flow_submit_generation for video so the saved resolution is set and checked before spending credits. Download through flow_download_media to retain the target resolution.",
        "Polling timeout and lastObservedAt describe local observation, not Google server progress. Retry flow_wait_for_generation with the same jobId; never infer failure or submit another version just because no matching media was found.",
        "Use this connected MCP instance for browser operations. Starting another stdio client against the same browser profile can conflict with its owner. After updating code, reconnect the MCP server before using the new build.",
      ].join(" "),
    },
  );

  server.registerTool(
    "mcp_health_check",
    {
      title: "Google Flow MCP health check",
      description: "Check the SQLite store, browser executable, profile, and current durable record counts without opening Google Flow.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const state = await store.read();
      const ffprobe = process.env.FLOW_FFPROBE_EXECUTABLE ?? "ffprobe";
      const ffprobeCheck = spawnSync(ffprobe, ["-version"], { windowsHide: true, timeout: 5_000 });
      return response({
        status: store.health().integrity === "ok" && existsSync(config.browserExecutable) && ffprobeCheck.status === 0 ? "healthy" : "degraded",
        version: "1.0.1",
        runtime: { processId: process.pid, startedAt, entrypoint: process.argv[1] },
        database: store.health(),
        browserExecutable: { path: config.browserExecutable, exists: existsSync(config.browserExecutable) },
        ffprobe: { command: ffprobe, available: ffprobeCheck.status === 0 },
        profileDir: config.profileDir,
        downloadDir: config.downloadDir,
        counts: { projects: state.projects.length, jobs: state.jobs.length, assets: state.assets.length },
      });
    },
  );

  server.registerTool(
    "media_validate_local",
    {
      title: "Validate a downloaded local media file",
      description: "Use ffprobe and SHA-256 to verify a local media file, its streams, duration, and aspect ratio.",
      inputSchema: z.object({
        filePath: z.string().min(1),
        expectedDurationSeconds: z.number().positive().optional(),
        durationToleranceSeconds: z.number().positive().default(0.25),
        expectedAspectRatio: z.string().regex(/^\d+:\d+$/).optional(),
        requireAudio: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => response(await validateMedia(input.filePath, input)),
  );

  server.registerTool(
    "state_backup",
    {
      title: "Back up the production state database",
      description: "Create and integrity-check a consistent SQLite backup. Existing destination files are never overwritten.",
      inputSchema: z.object({ destinationPath: z.string().min(1).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ destinationPath }) => response(await store.backup(destinationPath)),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create Google Flow project state",
      description: "Create durable local project state without resetting the browser login. Reuse an existing project when continuing work. Save the user's final video resolution when known; ask before video preparation if it is still unspecified.",
      inputSchema: z.object({
        title: z.string().min(1),
        brief: z.string().default(""),
        durationSeconds: z.number().positive().optional(),
        aspectRatio: z.string().optional(),
        language: z.string().default("zh-CN"),
        finalVideoResolution: z.enum(["720p", "1080p"]).optional().describe("Final delivery quality, not generation resolution. Ask the user if unknown before preparing video."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => response(await store.createProject(input)),
  );

  server.registerTool(
    "project_list",
    {
      title: "List projects",
      description: "List local Google Flow projects and their durable stages.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => response({ projects: (await store.read()).projects }),
  );

  server.registerTool(
    "project_get",
    {
      title: "Get project",
      description: "Get one project plus all of its jobs.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => {
      const state = await store.read();
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      return response({
        project,
        jobs: state.jobs.filter((job) => job.projectId === projectId),
        assets: state.assets.filter((asset) => asset.projectId === projectId),
      });
    },
  );

  server.registerTool(
    "flow_start_login",
    {
      title: "Open Google Flow login",
      description: "Reuse a confirmed session or an existing pending login. Open ordinary visible Chrome only when user login is needed. Once the user reports completion, call flow_confirm_login instead of restarting login.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        reopen: z.boolean().default(false).describe("Use only when the user explicitly asks to reopen a closed unfinished login window or change accounts. Normal retries reuse the existing session."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, reopen }) => response(await flow.startLogin(projectId, reopen)),
  );

  server.registerTool(
    "flow_auth_status",
    {
      title: "Check Google Flow login status",
      description: "Check browser navigation state without reading credential fields. A pending user confirmation is not proof of expired login. When the user reports login completed and the window closed, call flow_confirm_login directly.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => response(await flow.getAuthStatus()),
  );

  server.registerTool(
    "flow_confirm_login",
    {
      title: "Confirm Google Flow login checkpoint",
      description: "After the user reports login completed and the login window closed, record their confirmation of account access and credits. A prior completed confirmation remains valid across projects; do not ask again merely to resume work.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        userConfirmedFreshSignIn: z.literal(true),
        membershipConfirmed: z.literal(true),
        creditsAvailableConfirmed: z.literal(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => response(await flow.confirmLogin(input)),
  );

  server.registerTool(
    "flow_inspect_page",
    {
      title: "Inspect visible Google Flow controls",
      description: "Return visible button and textbox labels without returning field values or credentials.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => response(await flow.inspectPage()),
  );

  server.registerTool(
    "flow_open_project",
    {
      title: "Open a Google Flow project",
      description: "Open and persist an official Google Flow project URL for the local project.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        projectUrl: z.string().url(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, projectUrl }) => {
      await projectGuard(projectId);
      const page = await flow.openFlowProject(projectUrl);
      const project = await store.linkFlowProject(projectId, projectUrl);
      return response({ project, page });
    },
  );

  server.registerTool(
    "flow_open_media",
    {
      title: "Open a Flow media detail page",
      description: "Open one media item discovered by flow_inspect_page using its tileId, providerMediaId, or unique title.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        mediaId: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
      }).refine((value) => value.mediaId !== undefined || value.title !== undefined, { message: "Provide mediaId or title." }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId, mediaId, title }) => {
      await projectGuard(projectId);
      const state = await store.read();
      const project = state.projects.find((item) => item.id === projectId)!;
      if (!project.flowProjectUrl) throw new Error("Project has no linked Google Flow URL.");
      return response(await flow.openMedia({ projectUrl: project.flowProjectUrl, mediaId, title }));
    },
  );

  const projectGuard = async (projectId: string) => {
    const state = await store.read();
    if (!state.projects.some((project) => project.id === projectId)) throw new Error(`Project not found: ${projectId}`);
    if (state.auth.status !== "ready") {
      if (state.auth.status === "awaiting_user_fresh_sign_in" || state.auth.status === "signed_in_unconfirmed") {
        throw new Error("Login is awaiting user confirmation. If the user has already reported login complete and closed the login window, call flow_confirm_login now. Otherwise wait for the user; do not restart login or keep polling for confirmation.");
      }
      throw new Error("The browser session is not ready. Check flow_auth_status and call flow_start_login only if user login is required.");
    }
  };

  server.registerTool(
    "flow_fill_text",
    {
      title: "Fill a Google Flow textbox",
      description: "Fill a visible non-credential textbox selected from flow_inspect_page.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        text: z.string().min(1),
        label: z.string().optional(),
        index: z.number().int().nonnegative().optional(),
      }).refine((value) => value.label !== undefined || value.index !== undefined, {
        message: "Provide label or index from flow_inspect_page.",
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, ...input }) => {
      await projectGuard(projectId);
      return response(await flow.fillTextbox(input));
    },
  );

  server.registerTool(
    "flow_upload_reference",
    {
      title: "Upload a reference asset",
      description: "Attach a local file to a visible Google Flow file input. The path is never placed into a prompt as a fake binding.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        filePath: z.string().min(1),
        inputIndex: z.number().int().nonnegative().optional(),
        role: z.string().min(1).default("ingredients"),
        locked: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, ...input }) => {
      await projectGuard(projectId);
      const page = await flow.uploadFile(input);
      const asset = await store.registerAsset({
        projectId, kind: "reference", role: input.role, sourcePath: input.filePath, locked: input.locked,
      });
      return response({ page, asset });
    },
  );

  server.registerTool(
    "flow_bind_asset",
    {
      title: "Bind a Flow asset to the prompt",
      description: "Drag one visible Google Flow asset card into the visible prompt textbox to create a real reference binding.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        assetLabel: z.string().min(1),
        promptLabel: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, ...input }) => {
      await projectGuard(projectId);
      return response(await flow.bindAssetToPrompt(input));
    },
  );

  server.registerTool(
    "flow_click_control",
    {
      title: "Click a visible Google Flow control",
      description: "Click an exact visible control. Credential and sign-out actions are blocked; possible credit-spending controls require approval.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        label: z.string().optional(),
        index: z.number().int().nonnegative().optional(),
        allowCreditSpend: z.boolean().default(false),
      }).refine((value) => value.label !== undefined || value.index !== undefined, {
        message: "Provide label or index from flow_inspect_page.",
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, ...input }) => {
      await projectGuard(projectId);
      return response(await flow.clickControl(input));
    },
  );

  server.registerTool(
    "flow_download_asset",
    {
      title: "Download a Google Flow asset",
      description: "Click a visible download control and save the resulting file to a local directory.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        label: z.string().optional(),
        index: z.number().int().nonnegative().optional(),
        destinationDir: z.string().min(1),
        fileName: z.string().min(1).optional(),
      }).refine((value) => value.label !== undefined || value.index !== undefined, {
        message: "Provide label or index from flow_inspect_page.",
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, ...input }) => {
      await projectGuard(projectId);
      return response(await flow.downloadAsset(input));
    },
  );

  server.registerTool(
    "flow_download_media",
    {
      title: "Download a completed Flow media item",
      description: "Download a completed media item. Videos inherit the job's final resolution, or the project target for direct media downloads; select the exact original/upscaled option at that resolution. Images retain original size. Target unavailability is reported, not silently downgraded.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        jobId: z.string().uuid().optional(),
        mediaId: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        destinationDir: z.string().min(1).optional(),
        fileName: z.string().min(1).optional(),
        resolution: z.enum(["original", "720p", "1080p"]).optional().describe("Omit to use the saved video delivery target. Use original only when the original generation size is wanted."),
      }).refine((value) => value.jobId !== undefined || value.mediaId !== undefined || value.title !== undefined, {
        message: "Provide jobId, mediaId, or title.",
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, jobId, mediaId, title, destinationDir, fileName, resolution }) => {
      await projectGuard(projectId);
      const state = await store.read();
      const project = state.projects.find((item) => item.id === projectId)!;
      if (!project.flowProjectUrl) throw new Error("Project has no linked Google Flow URL.");
      const job = jobId ? state.jobs.find((item) => item.id === jobId && item.projectId === projectId) : undefined;
      if (jobId && !job) throw new Error(`Job not found in project: ${jobId}`);
      const downloadResolution = job?.operation === "image" ? "original"
        : resolution ?? job?.finalVideoResolution ?? project.finalVideoResolution ?? "original";
      const result = await flow.downloadMedia({
        projectUrl: project.flowProjectUrl,
        mediaId: mediaId ?? job?.providerMediaId,
        title,
        destinationDir: destinationDir ?? config.downloadDir ?? "downloads",
        fileName,
        resolution: downloadResolution,
      });
      if (job) await store.updateJob(job.id, {
        state: "complete", providerMediaId: result.media.tileId,
        providerMediaUrl: result.media.href, downloadPath: result.path, lastObservedAt: new Date().toISOString(),
        downloadedResolution: result.downloadedResolution, downloadVariant: result.downloadVariant,
      });
      const asset = await store.registerAsset({
        projectId, kind: result.media.kind === "unknown" ? "other" : result.media.kind,
        role: "generated", title: result.media.title, sourcePath: result.path,
        providerMediaId: result.media.tileId, providerMediaUrl: result.media.href,
        downloadedResolution: result.downloadedResolution, downloadVariant: result.downloadVariant,
        checksum: await sha256File(result.path), locked: true,
      });
      return response({ ...result, asset });
    },
  );

  server.registerTool(
    "flow_prepare_generation",
    {
      title: "Prepare a Google Flow generation",
      description: "Prepare without spending credits. For video, first establish finalVideoResolution from the user or saved project: 720p defaults to 360p generation; 1080p defaults to 720p generation. Applies the generation setting and saves both resolutions. Reuses an existing job's resolution plan unless an explicit conflicting plan is supplied.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        operation: z.enum(["image", "video"]),
        shotIndex: z.number().int().nonnegative(),
        version: z.number().int().positive().default(1),
        prompt: z.string().min(1),
        textboxLabel: z.string().optional(),
        textboxIndex: z.number().int().nonnegative().optional(),
        finalVideoResolution: z.enum(["720p", "1080p"]).optional().describe("User-selected delivery resolution, saved for later shots in this project."),
        generationResolution: z.enum(["360p", "720p"]).optional().describe("Optional explicit source quality; otherwise use the lower-resolution route. 1080p delivery requires 720p generation."),
      }).refine((value) => value.textboxLabel !== undefined || value.textboxIndex !== undefined, {
        message: "Provide textboxLabel or textboxIndex from flow_inspect_page.",
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      await projectGuard(input.projectId);
      const idempotencyKey = `${input.projectId}:${input.operation}:${input.shotIndex}:${input.version}`;
      const current = await store.read();
      const existing = current.jobs.find((job) => job.idempotencyKey === idempotencyKey && job.state !== "failed");
      if (existing) {
        if (input.operation === "video" && (
          (input.finalVideoResolution && input.finalVideoResolution !== existing.finalVideoResolution)
          || (input.generationResolution && input.generationResolution !== existing.generationResolution)
        )) throw new Error("This shot/version already has a different video resolution plan. Use a new version for a new plan; the existing job was not changed.");
        return response({ job: existing, reused: true });
      }
      assertNoUnresolvedShot(current.jobs, idempotencyKey);
      const project = current.projects.find((item) => item.id === input.projectId)!;
      const finalVideoResolution = input.operation === "video" ? input.finalVideoResolution ?? project.finalVideoResolution : undefined;
      if (input.operation === "video" && !finalVideoResolution) {
        throw new Error("Ask the user for the final video resolution (720p or 1080p), then pass finalVideoResolution. No video job was created or submitted.");
      }
      const generationResolution = finalVideoResolution
        ? input.generationResolution ?? (finalVideoResolution === "720p" ? "360p" : "720p") : undefined;
      if (finalVideoResolution === "1080p" && generationResolution !== "720p") {
        throw new Error("1080p delivery requires 720p generation for Flow's matching upscale option.");
      }
      const created = await store.createJob({
        projectId: input.projectId,
        operation: input.operation,
        idempotencyKey,
        prompt: input.prompt,
        finalVideoResolution, generationResolution,
      });
      if (created.reused) return response(created);
      try {
        if (generationResolution) await flow.configureVideoResolution(generationResolution);
        const baselinePage = await flow.inspectPage();
        const page = await flow.fillTextbox({
          text: input.prompt,
          label: input.textboxLabel,
          index: input.textboxIndex,
        });
        const baselineMediaIds = baselinePage.media.flatMap((item) => [item.tileId, item.providerMediaId].filter((value): value is string => Boolean(value)));
        const job = await store.updateJob(created.job.id, {
          state: "prepared", baselineMediaIds, baselineFailureCount: baselinePage.failureCount,
        });
        if (input.operation === "video" && input.finalVideoResolution) {
          await store.update((state) => {
            const saved = state.projects.find((item) => item.id === input.projectId)!;
            saved.finalVideoResolution = input.finalVideoResolution;
            saved.updatedAt = new Date().toISOString();
          });
        }
        return response({ job, reused: false, page });
      } catch (error) {
        await store.updateJob(created.job.id, { state: "failed", error: (error as Error).message });
        throw error;
      }
    },
  );

  server.registerTool(
    "flow_submit_generation",
    {
      title: "Submit a prepared Google Flow generation",
      description: "Click the selected generation control and mark the job submitted. Explicit user approval is mandatory because credits may be spent.",
      inputSchema: z.object({
        jobId: z.string().uuid(),
        buttonLabel: z.string().optional(),
        buttonIndex: z.number().int().nonnegative().optional(),
        userApprovedCreditSpend: z.literal(true),
      }).refine((value) => value.buttonLabel !== undefined || value.buttonIndex !== undefined, {
        message: "Provide buttonLabel or buttonIndex from flow_inspect_page.",
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ jobId, buttonLabel, buttonIndex }) => {
      const state = await store.read();
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      if (job.state === "submitted" || job.state === "generating" || job.state === "complete") {
        return response({ job, reused: true });
      }
      if (job.state !== "prepared") throw new Error(`Job must be prepared before submission; current state is ${job.state}.`);
      await projectGuard(job.projectId);
      assertNoUnresolvedShot(state.jobs, job.idempotencyKey, job.id);
      if (job.operation === "video") {
        if (!job.finalVideoResolution || !job.generationResolution) {
          throw new Error("This prepared video has no saved resolution plan. Ask for the delivery target and prepare a new version before spending credits.");
        }
        const actualResolution = await flow.inspectVideoResolution();
        if (actualResolution !== job.generationResolution) {
          throw new Error(`Video resolution changed: prepared ${job.generationResolution}, page shows ${actualResolution ?? "unknown"}. Restore the prepared setting before submission; no credits were spent.`);
        }
      }
      try {
        const page = await flow.clickControl({
          label: buttonLabel,
          index: buttonIndex,
          allowCreditSpend: true,
        });
        const updated = await store.updateJob(job.id, { state: "submitted", error: undefined, submittedAt: new Date().toISOString() });
        return response({ job: updated, reused: false, page });
      } catch (error) {
        await store.updateJob(job.id, { state: "failed", error: (error as Error).message });
        throw error;
      }
    },
  );

  server.registerTool(
    "flow_wait_for_generation",
    {
      title: "Wait for a real Google Flow generation result",
      description: "Observe the linked Flow project for a new media tile, repeated failure notices, or timeout. Timeout means the provider result is unknown, not failed or confirmed generating. Retry this tool with the same jobId; do not submit a replacement based only on timeout or lastObservedAt.",
      inputSchema: z.object({
        jobId: z.string().uuid(),
        timeoutSeconds: z.number().int().min(10).max(1800).default(600),
        pollIntervalSeconds: z.number().int().min(3).max(60).default(10),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ jobId, timeoutSeconds, pollIntervalSeconds }) => {
      const state = await store.read();
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      if (job.state === "complete") return response({ job, reused: true });
      if (!["submitted", "generating"].includes(job.state)) throw new Error(`Job must be submitted or generating; current state is ${job.state}.`);
      await projectGuard(job.projectId);
      const project = state.projects.find((item) => item.id === job.projectId)!;
      if (!project.flowProjectUrl) throw new Error("Project has no linked Google Flow URL.");
      if (job.state === "submitted") await store.updateJob(job.id, { state: "generating", lastObservedAt: new Date().toISOString() });
      const observed = await flow.waitForMedia({
        projectUrl: project.flowProjectUrl,
        baselineMediaIds: job.baselineMediaIds ?? [],
        baselineFailureCount: job.baselineFailureCount ?? 0,
        expectedKind: job.operation === "image" ? "image" : "video",
        timeoutSeconds,
        pollIntervalSeconds,
      });
      if (observed.status === "complete" && observed.media) {
        const updated = await store.updateJob(job.id, {
          state: "complete", providerMediaId: observed.media.tileId, providerMediaUrl: observed.media.href,
          lastObservedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: undefined,
        });
        const asset = await store.registerAsset({
          projectId: job.projectId, kind: observed.media.kind === "unknown" ? "other" : observed.media.kind,
          role: "generated", title: observed.media.title, providerMediaId: observed.media.tileId,
          providerMediaUrl: observed.media.href, locked: true,
        });
        return response({ status: "complete", job: updated, media: observed.media, asset, observations: observed.observations });
      }
      if (observed.status === "failed") {
        const updated = await store.updateJob(job.id, {
          state: "failed", error: "Google Flow showed a failure state in three consecutive observations.", lastObservedAt: new Date().toISOString(),
        });
        return response({ status: "failed", job: updated, observations: observed.observations });
      }
      const updated = await store.updateJob(job.id, { state: "generating", lastObservedAt: new Date().toISOString() });
      return response({
        status: "timeout", providerStatus: "unknown", job: updated, observations: observed.observations,
        observation: { pageUrl: observed.page.url, pageTitle: observed.page.title, visibleMediaCount: observed.page.media.length, failureCount: observed.page.failureCount },
        retrySafe: true, retryAction: "flow_wait_for_generation", resubmitSafe: false,
        message: "No matching result was observed before timeout. The saved generating state and lastObservedAt track local polling, not confirmed Google queue progress. Continue observing this job or inspect the project; do not submit a replacement based on this timeout.",
      });
    },
  );

  server.registerTool(
    "job_record_result",
    {
      title: "Record an observed Flow job result",
      description: "Persist a real observed completion, failure, or provider media ID after checking Google Flow.",
      inputSchema: z.object({
        jobId: z.string().uuid(),
        state: z.enum(["generating", "complete", "failed", "paused"]),
        providerMediaId: z.string().optional(),
        error: z.string().optional(),
      }).superRefine((value, context) => {
        if (value.state === "complete" && !value.providerMediaId) {
          context.addIssue({ code: "custom", message: "providerMediaId is required when recording completion.", path: ["providerMediaId"] });
        }
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobId, ...patch }) => response(await store.updateJob(jobId, patch)),
  );

  return { server, flow, store };
}
