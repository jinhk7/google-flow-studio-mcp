import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright-core";

import { loadConfig } from "../src/config.js";
import { FlowBrowserAdapter } from "../src/flow-adapter.js";

test("an empty ProseMirror prompt has a stable label distinct from the project title", async (t) => {
  const browser = await chromium.launch({ executablePath: loadConfig().browserExecutable, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto("data:text/html," + encodeURIComponent(`
    <input aria-label="Project title" value="Sample project">
    <div contenteditable="true" translate="no" class="ProseMirror"><p><br class="ProseMirror-trailingBreak"></p></div>
  `));

  const label = FlowBrowserAdapter.prototype["controlLabel"];
  const prompt = page.locator(".ProseMirror");
  assert.equal(await label(prompt), "Flow prompt");
  assert.equal(await label(page.locator("input")), "Project title");
  await prompt.fill("A photorealistic portrait of a traveler.");
  assert.equal(await label(prompt), "Flow prompt");
  assert.equal(await page.locator("input").inputValue(), "Sample project");
});

test("Flow discovers linked media, image IDs, and unique video titles", async (t) => {
  const browser = await chromium.launch({ executablePath: loadConfig().browserExecutable, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const imageSource = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const oldHref = "https://labs.google/fx/tools/flow/project/project-one/edit/old-tile";
  await page.route("http://flow-fixture.local/**", (route) => route.fulfill({ contentType: "text/html", body: `
    <div data-tile-id="fe_id_old-tile">
      <a href="${oldHref}"><img src="${imageSource}" width="64" height="64" alt="Old portrait"></a>
    </div>
    <flow-grid-tile-container aria-label="Man holding coat lapel">
      <flow-tile-container><div class="container"><flow-image-tile><div class="container">
        <img class="image" data-media-id="22222222-2222-4222-8222-222222222222" alt="User image tile" src="${imageSource}" width="64" height="64">
      </div></flow-image-tile></div></flow-tile-container>
    </flow-grid-tile-container>
    <flow-grid-tile-container aria-label="Park bench">
      <flow-image-tile><img data-media-id="second-image" src="${imageSource}" width="64" height="64"></flow-image-tile>
    </flow-grid-tile-container>
    <flow-grid-tile-container aria-label="Man sitting looking at street">
      <flow-video-tile><img data-media-id="poster-image-only" src="${imageSource}" width="64" height="64"></flow-video-tile>
    </flow-grid-tile-container>
    <flow-grid-tile-container aria-label="Duplicate video"><video width="64" height="64"></video></flow-grid-tile-container>
    <flow-grid-tile-container aria-label="Duplicate video"><video width="64" height="64"></video></flow-grid-tile-container>
    <flow-grid-tile-container aria-label="Park bench"><video width="64" height="64"></video></flow-grid-tile-container>
  ` }));
  await page.goto("http://flow-fixture.local/");

  const media = await Reflect.apply(FlowBrowserAdapter.prototype["inspectMedia"], { ensurePage: async () => page }, []);
  assert.equal(media.length, 4);
  assert.equal(media[0].tileId, "old-tile");
  assert.equal(media[0].href, oldHref);
  assert.equal(media[1].providerMediaId, "22222222-2222-4222-8222-222222222222");
  assert.equal(media[1].tileId, media[1].providerMediaId);
  assert.equal(media[1].title, "Man holding coat lapel");
  assert.equal(media[1].kind, "image");
  assert.equal(media[1].href, undefined);
  assert.equal(media[2].tileId, "second-image");
  assert.equal(media[3].tileId, "title:Man sitting looking at street");
  assert.equal(media[3].kind, "video");
  assert.equal(media[3].providerMediaId, undefined);
  assert.equal(media[3].href, undefined);
  assert.equal(await FlowBrowserAdapter.prototype["controlLabel"](page.locator("flow-grid-tile-container").first()), "Man holding coat lapel");
});

test("opening a titled video captures the actual detail ID and URL", async (t) => {
  const browser = await chromium.launch({ executablePath: loadConfig().browserExecutable, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const projectUrl = "http://flow-fixture.local/project/test";
  const detailUrl = `${projectUrl}/edit/real-edit-id`;
  await page.route("http://flow-fixture.local/**", (route) => route.fulfill({ contentType: "text/html", body:
    route.request().url() === detailUrl ? '<button aria-label="Download media">Download</button>' : `
      <flow-grid-tile-container aria-label="Man sitting looking at street" onclick="location.href='/project/test/edit/real-edit-id'">
        <flow-video-tile><video width="64" height="64"></video></flow-video-tile>
      </flow-grid-tile-container>
    `
  }));
  await page.goto(projectUrl);
  const inspect = () => Reflect.apply(FlowBrowserAdapter.prototype["inspectMedia"], { ensurePage: async () => page }, []);
  const opened = await Reflect.apply(FlowBrowserAdapter.prototype.openMedia, {
    openFlowProject: async () => undefined,
    ensurePage: async () => page,
    findMedia: async () => (await inspect())[0],
    inspectPage: async () => ({ url: page.url() }),
  }, [{ projectUrl, title: "Man sitting looking at street" }]);
  assert.equal(opened.media.tileId, "real-edit-id");
  assert.equal(opened.media.href, detailUrl);
  assert.equal(opened.media.providerMediaId, undefined);
});

test("download resolution selects the requested visible option and rejects upgrades without fallback", async (t) => {
  const browser = await chromium.launch({ executablePath: loadConfig().browserExecutable, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <p>His original street clothing remains unchanged.</p>
    <button>270p GIF 动画</button>
    <button>360p 原始尺寸</button>
    <button>720p 已高清重塑</button>
    <button disabled>1080p 升级</button>
  `);
  const adapter: FlowBrowserAdapter = Object.create(FlowBrowserAdapter.prototype);
  adapter["ensurePage"] = async () => page;
  const original = await adapter["selectDownloadOption"]("original");
  assert.equal(original.downloadedResolution, "360p");
  assert.equal(original.downloadVariant, "original");
  const hd = await adapter["selectDownloadOption"]("720p");
  assert.equal(hd.downloadedResolution, "720p");
  assert.equal(hd.downloadVariant, "upscaled");
  await assert.rejects(() => adapter["selectDownloadOption"]("1080p"), /requires an account upgrade/);

  await page.setContent('<button>720p 原始尺寸</button><button role="menuitem">1080p 已高清重塑</button>');
  const fullHd = await adapter["selectDownloadOption"]("1080p");
  assert.equal(fullHd.downloadedResolution, "1080p");
  assert.equal(fullHd.downloadVariant, "upscaled");
  await page.getByRole("menuitem").evaluate((element) => element.setAttribute("aria-disabled", "true"));
  await assert.rejects(() => adapter["selectDownloadOption"]("1080p"), /is disabled/);
  await page.getByRole("menuitem").evaluate((element) => element.remove());
  await assert.rejects(() => adapter["selectDownloadOption"]("1080p"), /found 0.*No other resolution/);
});

test("a timed-out download call resumes the same pending request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter: FlowBrowserAdapter = Object.create(FlowBrowserAdapter.prototype);
  let requests = 0;
  let finish: (value: Awaited<ReturnType<FlowBrowserAdapter["downloadMedia"]>>) => void = () => undefined;
  adapter["downloadMediaOnce"] = async () => {
    requests += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  const input = { projectUrl: "https://flow.google.com/project/test", mediaId: "media-one", destinationDir: "downloads", resolution: "1080p" as const };
  const waiting = adapter.downloadMedia(input);
  t.mock.timers.tick(50_000);
  await assert.rejects(() => waiting, /same parameters.*not be submitted again/);
  const resumed = adapter.downloadMedia(input);
  finish({ path: "clip.mp4", suggestedFileName: "clip.mp4", sourceUrl: "https://flow.google.com/project/test/edit/media-one", media: { tileId: "media-one", title: "Clip", kind: "video" }, bytes: 1, downloadedResolution: "1080p", downloadVariant: "upscaled" });
  assert.equal((await resumed).downloadedResolution, "1080p");
  assert.equal(requests, 1);
});

test("a terminal download failure after a soft timeout releases the pending request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter: FlowBrowserAdapter = Object.create(FlowBrowserAdapter.prototype);
  let requests = 0;
  let fail: (reason: Error) => void = () => undefined;
  adapter["downloadMediaOnce"] = async () => {
    requests += 1;
    if (requests === 1) return new Promise((_, reject) => { fail = reject; });
    return { path: "next.mp4", suggestedFileName: "next.mp4", sourceUrl: "https://flow.google.com/project/test/edit/media-two", media: { tileId: "media-two", title: "Next", kind: "video" }, bytes: 1 };
  };
  const input = { projectUrl: "https://flow.google.com/project/test", mediaId: "media-one", destinationDir: "downloads", resolution: "720p" as const };
  const waiting = adapter.downloadMedia(input);
  t.mock.timers.tick(50_000);
  await assert.rejects(() => waiting, /still processing/);
  fail(new Error("Download save failed"));
  await adapter["pendingMediaDownload"]?.result.catch(() => undefined);
  const next = await adapter.downloadMedia({ ...input, mediaId: "media-two" });
  assert.equal(next.media.tileId, "media-two");
  assert.equal(requests, 2);
});

test("video resolution uses checked radios, reads the visible summary, and preserves existing inputs", async (t) => {
  const browser = await chromium.launch({ executablePath: loadConfig().browserExecutable, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div contenteditable="true" class="ProseMirror">The traveler keeps the leaf on his right knee.</div>
    <div id="start-frame" data-media-id="frame-one">Start frame</div>
    <div id="reference" data-media-id="soapy-reference">Reference</div>
    <button id="settings" aria-label="设置触发器" onclick="document.getElementById('popover').hidden = !document.getElementById('popover').hidden">
      <span class="settings-summary">视频 · 360p · 8 秒</span> crop_16_9 x1
    </button>
    <div id="popover" hidden>
      <button id="image" role="radio" aria-checked="true">image 图片</button>
      <button id="video" role="radio" aria-checked="false" onclick="this.setAttribute('aria-checked','true'); document.getElementById('image').setAttribute('aria-checked','false')">videocam 视频</button>
      <button id="model">Veo 3.1 Fast</button>
      <button id="duration" role="radio" aria-checked="true">8 秒</button>
      <button id="r360" role="radio" aria-checked="true" onclick="setResolution('360p')"><span class="toggle-text">360p</span><span role="img" aria-label="360p 分辨率的清晰度较低，生成速度较快">info</span></button>
      <button id="r720" role="radio" aria-checked="false" onclick="setResolution('720p')">720p</button>
    </div>
    <script>
      function setResolution(value) {
        document.getElementById('r360').setAttribute('aria-checked', String(value === '360p'));
        document.getElementById('r720').setAttribute('aria-checked', String(value === '720p'));
        document.querySelector('.settings-summary').textContent = '视频 · ' + value + ' · 8 秒';
      }
    </script>
  `);
  const adapter: FlowBrowserAdapter = Object.create(FlowBrowserAdapter.prototype);
  adapter["ensurePage"] = async () => page;
  assert.equal(await adapter.inspectVideoResolution(), "360p");
  assert.equal(await adapter.configureVideoResolution("720p"), "720p");
  assert.equal(await page.locator("#popover").isVisible(), false);
  assert.equal(await page.locator("#start-frame").getAttribute("data-media-id"), "frame-one");
  assert.equal(await page.locator("#reference").getAttribute("data-media-id"), "soapy-reference");
  assert.equal(await page.locator(".ProseMirror").innerText(), "The traveler keeps the leaf on his right knee.");
  assert.equal(await page.locator("#model").textContent(), "Veo 3.1 Fast");
  assert.equal(await page.locator("#duration").getAttribute("aria-checked"), "true");
  await page.getByRole("button", { name: "设置触发器" }).click();
  assert.equal(await adapter.configureVideoResolution("360p"), "360p");
  assert.equal(await page.locator("#popover").isVisible(), true);
  await page.locator("#r720").evaluate((element) => element.setAttribute("disabled", ""));
  await assert.rejects(() => adapter.configureVideoResolution("720p"), /is disabled/);
  assert.equal(await adapter.inspectVideoResolution(), "360p");
});
