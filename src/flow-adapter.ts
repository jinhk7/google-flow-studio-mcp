import { spawn } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Download, type Locator, type Page } from "playwright-core";

import type { Config } from "./config.js";
import { StateStore } from "./state.js";
import type { AuthRecord, FlowMediaItem, PageInspection } from "./types.js";

const FLOW_URL = "https://flow.google.com";
const CREDIT_ACTION = /^(generate|create|生成|制作|产生)(\s|$)/i;
const BLOCKED_AUTH_ACTION = /(password|passkey|verification|验证码|验证|sign\s*out|log\s*out|退出登录|登出)/i;

type VisibleControl = { locator: Locator; label: string; frame: number };
type MediaDownloadInput = {
  projectUrl: string; mediaId?: string; title?: string; destinationDir: string; fileName?: string;
  resolution?: "original" | "720p" | "1080p";
};
type MediaDownloadResult = {
  path: string; suggestedFileName: string; sourceUrl: string; media: FlowMediaItem; bytes: number;
  downloadedResolution?: "360p" | "720p" | "1080p";
  downloadVariant?: "original" | "upscaled";
};

export class FlowBrowserAdapter {
  private context?: BrowserContext;
  private page?: Page;
  private pendingMediaDownload?: {
    key: string;
    result: Promise<MediaDownloadResult>;
  };

  constructor(private readonly config: Config, private readonly store: StateStore) {}

  async startLogin(projectId: string): Promise<AuthRecord> {
    const state = await this.store.read();
    if (!state.projects.some((project) => project.id === projectId)) throw new Error(`Project not found: ${projectId}`);
    await this.close();
    const loginBrowser = spawn(this.config.browserExecutable, [
      `--user-data-dir=${this.config.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      FLOW_URL,
    ], { detached: true, stdio: "ignore", windowsHide: false });
    loginBrowser.unref();
    const next = await this.store.update((draft) => {
      draft.auth = {
        status: "awaiting_user_fresh_sign_in",
        initiatedAt: new Date().toISOString(),
        lastUrl: FLOW_URL,
        lastMessage: "请在普通 Chrome 中亲自完成全新登录。进入 Flow 后关闭此专用 Chrome 的所有窗口，再让 AI 确认登录。不要把密码或验证码发送给 AI。",
      };
    });
    return next.auth;
  }

  async getAuthStatus(): Promise<AuthRecord> {
    if (!this.context || !this.page || this.page.isClosed()) return (await this.store.read()).auth;
    const detected = await this.detectAuthentication();
    const state = await this.store.read();
    const status = detected === "login_required" ? "login_required" : state.auth.status === "ready" ? "ready" : "signed_in_unconfirmed";
    const next = await this.store.update((draft) => {
      draft.auth.status = status;
      draft.auth.lastUrl = this.page!.url();
      draft.auth.lastMessage = status === "login_required"
        ? "请在可见浏览器中完成 Google 登录。"
        : status === "ready" ? "登录检查点已完成。" : "浏览器已登录；仍需用户确认全新登录、会员资格和可用额度。";
    });
    return next.auth;
  }

  async confirmLogin(input: {
    projectId: string;
    userConfirmedFreshSignIn: boolean;
    membershipConfirmed: boolean;
    creditsAvailableConfirmed: boolean;
  }): Promise<AuthRecord> {
    if (!input.userConfirmedFreshSignIn) throw new Error("Fresh sign-in must be completed and confirmed by the user.");
    if (!input.membershipConfirmed || !input.creditsAvailableConfirmed) {
      throw new Error("Google Flow membership/access and usable credits must be confirmed before generation.");
    }
    const state = await this.store.read();
    if (!state.projects.some((project) => project.id === input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    try {
      const page = await this.ensurePage();
      if (!page.url().startsWith(FLOW_URL)) await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if ((await this.detectAuthentication()) === "login_required") throw new Error("Google still shows a login page. Complete login in the normal Chrome window first.");
    } catch (error) {
      if (/profile.*in use|processsingleton|user data directory.*in use|singletonlock/i.test((error as Error).message)) {
        throw new Error("The login Chrome is still running. Close all windows using the dedicated Flow profile, then confirm login again.", { cause: error });
      }
      throw error;
    }
    const next = await this.store.update((draft) => {
      draft.auth.status = "ready";
      draft.auth.confirmedAt = new Date().toISOString();
      draft.auth.freshLoginForProjectId = input.projectId;
      draft.auth.lastUrl = this.page?.url();
      draft.auth.lastMessage = "Fresh login, membership/access, and usable credits were user-confirmed.";
    });
    return next.auth;
  }

  async inspectPage(): Promise<PageInspection> {
    const page = await this.ensurePage();
    const buttons = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
    const textboxes = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
    let fileInputCount = 0;
    for (const frame of page.frames()) fileInputCount += await frame.locator("input[type='file']").count();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    return {
      url: page.url(),
      title: await page.title(),
      visibleText: bodyText.replace(/\s+/g, " ").trim().slice(0, 12_000),
      buttons: buttons.slice(0, 120).map((control, index) => ({ index, label: control.label, frame: control.frame })),
      textboxes: await Promise.all(textboxes.slice(0, 40).map(async (control, index) => ({
        index,
        label: control.label,
        multiline: await control.locator.evaluate((element) => element.tagName === "TEXTAREA" || element.getAttribute("aria-multiline") === "true"),
        frame: control.frame,
      }))),
      fileInputCount,
      media: await this.inspectMedia(),
      failureCount: (bodyText.match(/\bwarning\s+Failed\b|生成失败/gi) ?? []).length,
    };
  }

  async openFlowProject(projectUrl: string): Promise<PageInspection> {
    this.validateFlowProjectUrl(projectUrl);
    const page = await this.ensurePage();
    await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000);
    return this.inspectPage();
  }

  async openMedia(input: { projectUrl: string; mediaId?: string; title?: string }): Promise<{ media: FlowMediaItem; page: PageInspection }> {
    await this.openFlowProject(input.projectUrl);
    const recorded = input.mediaId ? (await this.store.read()).assets.find((asset) =>
      asset.providerMediaId === input.mediaId && asset.providerMediaUrl?.startsWith(`${input.projectUrl}/edit/`)) : undefined;
    const media: FlowMediaItem = recorded ? {
      tileId: input.mediaId!, title: recorded.title ?? input.mediaId!, href: recorded.providerMediaUrl,
      kind: recorded.kind === "image" || recorded.kind === "video" ? recorded.kind : "unknown",
    } : await this.findMedia(input);
    const page = await this.ensurePage();
    if (media.href) {
      await page.goto(media.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } else {
      const tile = media.providerMediaId
        ? page.locator(`flow-grid-tile-container [data-media-id="${media.providerMediaId}"]`)
        : page.locator("flow-grid-tile-container").and(page.getByLabel(media.title, { exact: true }));
      await Promise.all([
        page.waitForURL((url) => /\/project\/[^/]+\/edit\/[^/]+/.test(url.pathname), { timeout: 30_000 }),
        tile.click(),
      ]);
      media.href = page.url();
      if (!media.providerMediaId) media.tileId = new URL(media.href).pathname.split("/").filter(Boolean).at(-1)!;
    }
    await page.getByRole("button", { name: /Download|下载/i }).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(500);
    return { media, page: await this.inspectPage() };
  }

  async waitForMedia(input: {
    projectUrl: string;
    baselineMediaIds: string[];
    baselineFailureCount: number;
    expectedKind: "image" | "video";
    timeoutSeconds: number;
    pollIntervalSeconds: number;
  }): Promise<{ status: "complete" | "failed" | "timeout"; media?: FlowMediaItem; observations: number; page: PageInspection }> {
    const page = await this.ensurePage();
    if (new URL(page.url()).pathname !== new URL(input.projectUrl).pathname) await this.openFlowProject(input.projectUrl);
    const baseline = new Set(input.baselineMediaIds);
    const deadline = Date.now() + input.timeoutSeconds * 1_000;
    let failedObservations = 0;
    let observations = 0;
    let inspection = await this.inspectPage();
    while (Date.now() <= deadline) {
      observations += 1;
      inspection = await this.inspectPage();
      const created = inspection.media.find((item) =>
        item.kind === input.expectedKind && !baseline.has(item.tileId) && (!item.providerMediaId || !baseline.has(item.providerMediaId)));
      if (created) {
        if (!created.href && !created.providerMediaId) {
          const opened = await this.openMedia({ projectUrl: input.projectUrl, title: created.title });
          return { status: "complete", media: opened.media, observations, page: opened.page };
        }
        return { status: "complete", media: created, observations, page: inspection };
      }
      failedObservations = inspection.failureCount > input.baselineFailureCount ? failedObservations + 1 : 0;
      if (failedObservations >= 3) return { status: "failed", observations, page: inspection };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await page.waitForTimeout(Math.min(input.pollIntervalSeconds * 1_000, remaining));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
    return { status: "timeout", observations, page: inspection };
  }

  async fillTextbox(input: { text: string; label?: string; index?: number }): Promise<PageInspection> {
    const page = await this.ensurePage();
    if (new URL(page.url()).hostname === "accounts.google.com") throw new Error("Credential entry is user-only. Type login details directly in the visible browser.");
    const controls = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
    const target = this.chooseControl(controls, input.label, input.index, "textbox");
    if (BLOCKED_AUTH_ACTION.test(target.label)) throw new Error("MCP refuses to fill credential or verification fields.");
    await target.locator.fill(input.text);
    return this.inspectPage();
  }

  async inspectVideoResolution(): Promise<"360p" | "720p" | undefined> {
    const page = await this.ensurePage();
    const summaries = page.locator("button .settings-summary");
    for (let index = 0; index < await summaries.count(); index += 1) {
      const summary = summaries.nth(index);
      if (!(await summary.isVisible())) continue;
      const resolution = (await summary.innerText()).match(/\b(360p|720p)\b/i)?.[1]?.toLowerCase();
      if (resolution === "360p" || resolution === "720p") return resolution;
    }
    return undefined;
  }

  async configureVideoResolution(resolution: "360p" | "720p"): Promise<"360p" | "720p"> {
    const page = await this.ensurePage();
    const trigger = page.getByRole("button", { name: /^(设置触发器|Settings trigger)$/i });
    const video = page.getByRole("radio", { name: /(?:^|\s)(?:视频|Video)(?:\s|$)/i });
    const openedHere = !(await video.isVisible());
    if (openedHere) await trigger.click();
    try {
      await video.waitFor({ state: "visible", timeout: 10_000 });
      if (await video.getAttribute("aria-checked") !== "true") {
        await video.click();
        await video.and(page.locator("[aria-checked='true']")).waitFor({ state: "visible", timeout: 10_000 });
      }
      const target = page.getByRole("radio", { name: new RegExp(`^${resolution}`, "i") });
      await target.waitFor({ state: "visible", timeout: 10_000 });
      if (!(await target.isEnabled())) throw new Error(`Flow generation resolution ${resolution} is disabled.`);
      if (await target.getAttribute("aria-checked") !== "true") await target.click();
      await target.and(page.locator("[aria-checked='true']")).waitFor({ state: "visible", timeout: 10_000 });
      await trigger.locator(".settings-summary").filter({ hasText: resolution }).waitFor({ state: "visible", timeout: 10_000 });
      const observed = await this.inspectVideoResolution();
      if (observed !== resolution) throw new Error(`Flow generation resolution readback was ${observed ?? "unavailable"}; expected ${resolution}.`);
      return observed;
    } finally {
      if (openedHere && await video.isVisible().catch(() => false)) await trigger.click();
    }
  }

  async uploadFile(input: { filePath: string; inputIndex?: number }): Promise<PageInspection> {
    const page = await this.ensurePage();
    const absolute = path.resolve(input.filePath);
    await access(absolute);
    const inputs: Locator[] = [];
    for (const frame of page.frames()) {
      const locator = frame.locator("input[type='file']");
      for (let index = 0; index < await locator.count(); index += 1) inputs.push(locator.nth(index));
    }
    if (inputs.length === 0) throw new Error("No file input is currently present. Inspect or open the upload control first.");
    const index = input.inputIndex ?? 0;
    if (!inputs[index]) throw new Error(`File input index ${index} does not exist.`);
    await inputs[index].setInputFiles(absolute);
    return this.inspectPage();
  }

  async bindAssetToPrompt(input: { assetLabel: string; promptLabel: string }): Promise<PageInspection> {
    const sources = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), flow-grid-tile-container[aria-label]");
    let source: VisibleControl;
    try { source = this.chooseControl(sources, input.assetLabel, undefined, "asset"); }
    catch (error) {
      const textMatches = await this.visibleExactText(input.assetLabel);
      if (textMatches.length !== 1) throw error;
      source = textMatches[0];
    }
    const prompts = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
    const prompt = this.chooseControl(prompts, input.promptLabel, undefined, "prompt textbox");
    await source.locator.dragTo(prompt.locator, { timeout: 30_000 });
    await this.page?.waitForTimeout(1_500);
    return this.inspectPage();
  }

  async clickControl(input: { label?: string; index?: number; allowCreditSpend: boolean }): Promise<PageInspection> {
    const controls = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
    let target: VisibleControl;
    try { target = this.chooseControl(controls, input.label, input.index, "button"); }
    catch (error) {
      if (!input.label || input.index !== undefined) throw error;
      const textMatches = await this.visibleExactText(input.label);
      if (textMatches.length !== 1) throw error;
      target = textMatches[0];
    }
    if (BLOCKED_AUTH_ACTION.test(target.label)) throw new Error("Signing out and credential-related actions are user-only.");
    if (CREDIT_ACTION.test(target.label) && !input.allowCreditSpend) throw new Error("This control may spend Google Flow credits. Set allowCreditSpend=true only after user approval.");
    await target.locator.click();
    await this.page?.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    try { return await this.inspectPage(); }
    catch {
      const page = await this.ensurePage();
      return { url: page.url(), title: await page.title().catch(() => ""), visibleText: "", buttons: [], textboxes: [], fileInputCount: 0, media: [], failureCount: 0 };
    }
  }

  async downloadAsset(input: { label?: string; index?: number; destinationDir: string; fileName?: string }): Promise<{ path: string; suggestedFileName: string; sourceUrl: string }> {
    const page = await this.ensurePage();
    const controls = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
    let target: VisibleControl;
    try { target = this.chooseControl(controls, input.label, input.index, "download control"); }
    catch (error) {
      if (!input.label || input.index !== undefined) throw error;
      const textMatches = await this.visibleExactText(input.label);
      if (textMatches.length !== 1) throw error;
      target = textMatches[0];
    }
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await target.locator.click();
    const download = await downloadPromise;
    return this.saveDownload(download, input.destinationDir, input.fileName, page.url());
  }

  async downloadMedia(input: MediaDownloadInput): Promise<MediaDownloadResult> {
    const key = JSON.stringify([input.projectUrl, input.mediaId, input.title, path.resolve(input.destinationDir), input.fileName, input.resolution ?? "original"]);
    let pending = this.pendingMediaDownload;
    if (pending && pending.key !== key) throw new Error("A Flow download is already pending. Finish it by retrying the same download parameters before starting another download.");
    if (!pending) {
      pending = { key, result: this.downloadMediaOnce(input) };
      this.pendingMediaDownload = pending;
      pending.result.catch(() => {
        if (this.pendingMediaDownload === pending) this.pendingMediaDownload = undefined;
      });
    }
    const stillPending = new Error("The existing Flow download is still processing. Retry downloadMedia with the same parameters to keep waiting; the download will not be submitted again.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending.result,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(stillPending), 50_000); }),
      ]);
      if (this.pendingMediaDownload === pending) this.pendingMediaDownload = undefined;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async downloadMediaOnce(input: MediaDownloadInput): Promise<MediaDownloadResult> {
    const { media } = await this.openMedia(input);
    const page = await this.ensurePage();
    const downloadControl = page.getByRole("button", { name: /Download|下载/i }).first();
    if (!(await downloadControl.isVisible().catch(() => false))) throw new Error("Flow media detail page does not expose a visible Download control.");
    const resolution = media.kind === "image" ? "original" : input.resolution ?? "original";
    let download: Download | undefined;
    let downloadedResolution: MediaDownloadResult["downloadedResolution"];
    let downloadVariant: MediaDownloadResult["downloadVariant"] = "original";
    if (media.kind === "video") {
      await downloadControl.click();
    } else {
      download = await Promise.all([
        page.waitForEvent("download", { timeout: 10_000 }).catch(() => undefined), downloadControl.click(),
      ]).then(([value]) => value);
    }
    if (!download) {
      const option = await this.selectDownloadOption(resolution);
      downloadedResolution = option.downloadedResolution;
      downloadVariant = option.downloadVariant;
      download = await Promise.all([page.waitForEvent("download", { timeout: 600_000 }), option.locator.click()]).then(([value]) => value);
    }
    if (!download) throw new Error("Flow did not produce a download.");
    const saved = await this.saveDownload(download, input.destinationDir, input.fileName, page.url());
    return { ...saved, media, bytes: (await stat(saved.path)).size, downloadedResolution, downloadVariant };
  }

  private async selectDownloadOption(resolution: "original" | "720p" | "1080p"): Promise<{
    locator: Locator; downloadedResolution?: "360p" | "720p" | "1080p"; downloadVariant: "original" | "upscaled";
  }> {
    const page = await this.ensurePage();
    const optionName = /(?:360p|720p|1080p|Original|原始尺寸|原图)/i;
    await page.getByRole("button", { name: optionName }).or(page.getByRole("menuitem", { name: optionName })).first()
      .waitFor({ state: "visible", timeout: 10_000 });
    const controls = await this.visibleControls("button, [role='button'], [role='menuitem']");
    const pattern = resolution === "original" ? /Original|原始尺寸|原图/i : new RegExp(`(?:^|\\s)${resolution}(?:\\s|$)`, "i");
    const matches = controls.filter((control) => pattern.test(control.label));
    if (matches.length !== 1) throw new Error(`Flow must expose exactly one ${resolution} download option; found ${matches.length}. No other resolution was selected.`);
    const option = matches[0];
    if (/upgrade|升级|subscribe|订阅/i.test(option.label)) throw new Error(`The ${resolution} download requires an account upgrade. No download option was clicked.`);
    if (!(await option.locator.isEnabled())) throw new Error(`The ${resolution} download option is disabled. No download option was clicked.`);
    const detected = option.label.match(/\b(360p|720p|1080p)\b/i)?.[1]?.toLowerCase();
    return {
      locator: option.locator,
      downloadedResolution: detected === "360p" || detected === "720p" || detected === "1080p" ? detected : undefined,
      downloadVariant: /upscal|高清重塑/i.test(option.label) ? "upscaled" : "original",
    };
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close();
  }

  private async ensurePage(): Promise<Page> {
    if (!this.context) {
      const context = await chromium.launchPersistentContext(this.config.profileDir, {
        executablePath: this.config.browserExecutable,
        headless: false,
        viewport: null,
        acceptDownloads: true,
        ignoreDefaultArgs: ["--no-sandbox"],
        args: ["--no-first-run", "--disable-default-apps"],
      });
      this.context = context;
      context.once("close", () => {
        if (this.context === context) { this.context = undefined; this.page = undefined; }
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages().find((candidate) => new URL(candidate.url()).hostname === "flow.google.com" || new URL(candidate.url()).hostname === "labs.google") ?? this.context.pages()[0] ?? await this.context.newPage();
    }
    if (this.page.url() === "about:blank") {
      await this.page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    return this.page;
  }

  private async inspectMedia(): Promise<FlowMediaItem[]> {
    const page = await this.ensurePage();
    const results: FlowMediaItem[] = [];
    for (const frame of page.frames()) {
      const tiles = frame.locator("[data-tile-id], flow-grid-tile-container");
      const count = Math.min(await tiles.count(), 200);
      for (let index = 0; index < count; index += 1) {
        const tile = tiles.nth(index);
        if (!(await tile.isVisible().catch(() => false))) continue;
        const item = await tile.evaluate((element) => {
          const domTileId = element.getAttribute("data-tile-id") ?? "";
          const anchor = element.querySelector("a[href*='/project/'][href*='/edit/']") as HTMLAnchorElement | null;
          const href = anchor ? new URL(anchor.href, location.origin).toString() : undefined;
          const video = element.querySelector("video") as HTMLVideoElement | null;
          const image = element.querySelector("img") as HTMLImageElement | null;
          const isVideo = Boolean(video || element.querySelector("flow-video-tile"));
          const source = isVideo ? video?.getAttribute("src") ?? "" : image?.getAttribute("src") ?? "";
          let providerMediaId = (isVideo ? video?.getAttribute("data-media-id") : image?.getAttribute("data-media-id")) ?? undefined;
          if (!providerMediaId) {
            try { providerMediaId = new URL(source, location.origin).searchParams.get("name") ?? undefined; } catch { providerMediaId = undefined; }
          }
          const leaf = Array.from(element.querySelectorAll("div")).find((node) => {
            const value = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
            return value.length > 2 && node.children.length === 0 && !/^(play|play_arrow|play_circle)$/i.test(value);
          });
          const title = element.getAttribute("aria-label") ?? leaf?.textContent?.replace(/\s+/g, " ").trim() ?? image?.getAttribute("alt") ?? domTileId;
          const tileId = href ? new URL(href).pathname.split("/").filter(Boolean).at(-1) ?? domTileId.replace(/^fe_id_/, "")
            : domTileId.replace(/^fe_id_/, "") || providerMediaId || (isVideo && title ? `title:${title}` : "");
          return {
            tileId,
            providerMediaId,
            title: title || tileId,
            kind: isVideo ? "video" as const : image ? "image" as const : "unknown" as const,
            href,
          };
        });
        if (item.tileId && item.kind !== "unknown") results.push(item);
      }
    }
    const identifiable = results.filter((item) => !item.tileId.startsWith("title:") || results.filter((other) => other.title === item.title).length === 1);
    return [...new Map(identifiable.map((item) => [item.tileId, item])).values()];
  }

  private async findMedia(input: { mediaId?: string; title?: string }): Promise<FlowMediaItem> {
    const normalizedTitle = input.title?.trim().toLocaleLowerCase();
    let lastMatches: FlowMediaItem[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const items = await this.inspectMedia();
      lastMatches = items.filter((item) =>
        (input.mediaId && (item.tileId === input.mediaId || item.providerMediaId === input.mediaId)) ||
        (normalizedTitle && item.title.toLocaleLowerCase().includes(normalizedTitle)));
      if (lastMatches.length === 1) return lastMatches[0];
      if (lastMatches.length > 1) break;
      await (await this.ensurePage()).waitForTimeout(2_000);
    }
    throw new Error(`Expected one Flow media item, found ${lastMatches.length}. Inspect flow_inspect_page.media and use tileId or providerMediaId.`);
  }

  private async saveDownload(download: Download, destinationDirInput: string, fileName: string | undefined, sourceUrl: string) {
    const suggestedFileName = download.suggestedFilename();
    const requestedName = fileName ? path.basename(fileName) : suggestedFileName;
    if (!requestedName || requestedName === "." || requestedName === "..") throw new Error("Invalid download file name.");
    const destinationDir = path.resolve(destinationDirInput);
    await mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, requestedName);
    await download.saveAs(destination);
    if ((await stat(destination)).size <= 0) throw new Error("Flow download completed with an empty file.");
    return { path: destination, suggestedFileName, sourceUrl };
  }

  private validateFlowProjectUrl(projectUrl: string): void {
    const url = new URL(projectUrl);
    const isProjectRoute = url.hostname === "flow.google.com"
      ? /^\/project\/[^/]+(?:\/|$)/.test(url.pathname)
      : url.hostname === "labs.google" && /^\/fx\/tools\/flow\/project\/[^/]+(?:\/|$)/.test(url.pathname);
    if (url.protocol !== "https:" || !isProjectRoute) {
      throw new Error("Only official Google Flow project URLs are allowed.");
    }
  }

  private async detectAuthentication(): Promise<"login_required" | "signed_in"> {
    const page = await this.ensurePage();
    const url = new URL(page.url());
    if (!["flow.google.com", "labs.google"].includes(url.hostname) || url.pathname === "/about") return "login_required";
    const signInLinks = page.locator("a[href*='accounts.google.com']").filter({ hasText: /sign in|登录|登入/i });
    return await signInLinks.count() ? "login_required" : "signed_in";
  }

  private async visibleControls(selector: string): Promise<VisibleControl[]> {
    const page = await this.ensurePage();
    const controls: VisibleControl[] = [];
    const frames = page.frames();
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const locator = frames[frameIndex].locator(selector);
      const count = Math.min(await locator.count(), 200);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const label = await this.controlLabel(item);
        if (label) controls.push({ locator: item, label, frame: frameIndex });
      }
    }
    return controls;
  }

  private async controlLabel(locator: Locator): Promise<string> {
    return locator.evaluate((element) => {
      const html = element as HTMLElement;
      const label = html.getAttribute("aria-label") ?? html.getAttribute("placeholder") ?? html.getAttribute("title")
        ?? (html.getAttribute("contenteditable") === "true" ? "Flow prompt" : html.innerText ?? html.textContent ?? "");
      return label.replace(/\s+/g, " ").trim().slice(0, 300);
    }).catch(() => "");
  }

  private async visibleExactText(label: string): Promise<VisibleControl[]> {
    const page = await this.ensurePage();
    const collect = async (exact: boolean): Promise<VisibleControl[]> => {
      const matches: VisibleControl[] = [];
      const frames = page.frames();
      for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const locator = frames[frameIndex].getByText(label, { exact });
        const count = Math.min(await locator.count(), 20);
        for (let index = 0; index < count; index += 1) {
          const item = locator.nth(index);
          if (await item.isVisible().catch(() => false)) matches.push({ locator: item, label, frame: frameIndex });
        }
      }
      return matches;
    };
    const exactMatches = await collect(true);
    return exactMatches.length > 0 ? exactMatches : collect(false);
  }

  private chooseControl(controls: VisibleControl[], label: string | undefined, index: number | undefined, kind: string): VisibleControl {
    if (typeof index === "number") {
      if (!controls[index]) throw new Error(`${kind} index ${index} does not exist.`);
      return controls[index];
    }
    if (!label) throw new Error(`Provide an exact ${kind} label or index from flow_inspect_page.`);
    const normalized = label.trim().toLocaleLowerCase();
    const matches = controls.filter((control) => control.label.toLocaleLowerCase() === normalized);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${kind} labelled "${label}", found ${matches.length}. Inspect the page and use an index.`);
    return matches[0];
  }
}
