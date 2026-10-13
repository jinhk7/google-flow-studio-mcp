import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { chromium, type BrowserContext } from "playwright-core";

import { loadConfig } from "../src/config.js";
import { FlowBrowserAdapter } from "../src/flow-adapter.js";
import { StateStore } from "../src/state.js";

function mockBrowser(t: TestContext) {
  let loginPage: "accounts" | "flow" | undefined;
  const windows: Array<{ profileDir: string; close(): Promise<void> }> = [];
  const launch = t.mock.method(chromium, "launchPersistentContext", async (profileDir: string) => {
    let closed = false;
    let url = "about:blank";
    let onClose = () => {};
    const page = {
      url: () => url,
      isClosed: () => closed,
      goto: async (target: string) => { url = loginPage === "accounts" ? "https://accounts.google.com/signin" : target; },
      locator: (selector: string) => ({
        filter() { return this; },
        count: async () => loginPage === "flow" && selector.includes("button") ? 1 : 0,
        nth() { return this; },
        isVisible: async () => loginPage === "flow",
      }),
    };
    const context = {
      pages: () => closed ? [] : [page],
      newPage: async () => { assert.equal(closed, false); return page; },
      once: (_event: string, handler: () => void) => { onClose = handler; },
      close: async () => { closed = true; onClose(); },
    };
    windows.push({ profileDir, close: context.close });
    return context as unknown as BrowserContext;
  });
  return { launch, windows, requireLogin: (page: "accounts" | "flow") => { loginPage = page; } };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-auth-test-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const project = await store.createProject({ title: "Login fixture", brief: "", language: "en-US" });
  await store.update((state) => { state.auth = { status: "browser_closed" }; });
  const spawn = t.mock.method(childProcess, "spawn", () => ({ unref() {} }));
  syncBuiltinESMExports();
  const adapter = new FlowBrowserAdapter({
    browserExecutable: "fixture-browser", profileDir: path.join(directory, "profile"),
    stateFile: path.join(directory, "state.json"), databaseFile: store.filePath,
  }, store);
  t.after(async () => {
    await adapter.close();
    store.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  });
  return { adapter, store, project, spawn };
}

test("repeated login requests preserve the pending window and confirmation step", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T00:00:00Z") });
  const { adapter, project, spawn } = await fixture(t);
  const first = await adapter.startLogin(project.id);
  t.mock.timers.tick(1_000);
  const second = await adapter.startLogin(project.id);
  const status = await adapter.getAuthStatus();
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(second.initiatedAt, first.initiatedAt);
  assert.equal(status.status, "awaiting_user_fresh_sign_in");
  assert.match(status.lastMessage ?? "", /flow_confirm_login/);
});

test("confirmed login is reused by start and repeated confirmation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T00:00:00Z") });
  const { adapter, project, spawn } = await fixture(t);
  const browser = mockBrowser(t);
  await adapter.startLogin(project.id);
  const confirmation = { projectId: project.id, userConfirmedFreshSignIn: true, membershipConfirmed: true, creditsAvailableConfirmed: true };
  const confirmed = await adapter.confirmLogin(confirmation);
  t.mock.timers.tick(1_000);
  const reused = await adapter.startLogin(project.id);
  assert.equal(reused.status, "ready");
  assert.equal(reused.confirmedAt, confirmed.confirmedAt);
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(browser.launch.mock.callCount(), 1);
  assert.equal((await adapter.confirmLogin(confirmation)).confirmedAt, confirmed.confirmedAt);
});

test("status restores a closed confirmed browser with the same profile", async (t) => {
  const { adapter, project, spawn } = await fixture(t);
  const browser = mockBrowser(t);
  await adapter.startLogin(project.id);
  const confirmed = await adapter.confirmLogin({ projectId: project.id, userConfirmedFreshSignIn: true, membershipConfirmed: true, creditsAvailableConfirmed: true });
  await browser.windows[0].close();
  const restored = await adapter.getAuthStatus();
  assert.equal(restored.status, "ready");
  assert.equal(restored.confirmedAt, confirmed.confirmedAt);
  assert.equal(browser.windows.length, 2);
  assert.equal(browser.windows[1].profileDir, browser.windows[0].profileDir);
  assert.equal(spawn.mock.callCount(), 1);
});

for (const loginPage of ["accounts", "flow"] as const) {
  test(`${loginPage} login pages require personal sign-in before confirmation`, async (t) => {
    const { adapter, project } = await fixture(t);
    const browser = mockBrowser(t);
    await adapter.startLogin(project.id);
    const confirmation = { projectId: project.id, userConfirmedFreshSignIn: true, membershipConfirmed: true, creditsAvailableConfirmed: true };
    await adapter.confirmLogin(confirmation);
    await browser.windows[0].close();
    browser.requireLogin(loginPage);
    await assert.rejects(() => adapter.confirmLogin(confirmation), /login page.*Complete login/);
    const status = await adapter.getAuthStatus();
    assert.equal(status.status, "login_required");
    assert.match(status.lastMessage ?? "", /flow_start_login/);
  });
}

test("another MCP using the profile leaves confirmed login reusable after retry", async (t) => {
  const { adapter, project, spawn } = await fixture(t);
  const browser = mockBrowser(t);
  await adapter.startLogin(project.id);
  const confirmed = await adapter.confirmLogin({ projectId: project.id, userConfirmedFreshSignIn: true, membershipConfirmed: true, creditsAvailableConfirmed: true });
  await browser.windows[0].close();
  browser.launch.mock.mockImplementationOnce(async () => {
    throw new Error("browserType.launchPersistentContext: Target page, context or browser has been closed\nOpening in existing browser session.");
  });
  await assert.rejects(() => adapter.getAuthStatus(), /profile.*another.*MCP.*retry/i);
  const recovered = await adapter.getAuthStatus();
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.confirmedAt, confirmed.confirmedAt);
  assert.equal(spawn.mock.callCount(), 1);
});

test("explicit reopen replaces a pending or confirmed login window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T00:00:00Z") });
  const { adapter, project, spawn } = await fixture(t);
  mockBrowser(t);
  const first = await adapter.startLogin(project.id);
  t.mock.timers.tick(1_000);
  const reopened = await adapter.startLogin(project.id, true);
  assert.equal(spawn.mock.callCount(), 2);
  assert.notEqual(reopened.initiatedAt, first.initiatedAt);
  await adapter.confirmLogin({ projectId: project.id, userConfirmedFreshSignIn: true, membershipConfirmed: true, creditsAvailableConfirmed: true });
  const switched = await adapter.startLogin(project.id, true);
  assert.equal(switched.status, "awaiting_user_fresh_sign_in");
  assert.equal(switched.confirmedAt, undefined);
  assert.equal(spawn.mock.callCount(), 3);
});

test("visible sign-out controls preserve login while a visible sign-in control requires it", async (t) => {
  const browser = await chromium.launch({ executablePath: loadConfig().browserExecutable, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
    <button>退出登录</button><button>登出</button><button>Sign out</button><button>Log out</button>
    <button hidden>登录</button>
  ` }));
  const { adapter, store } = await fixture(t);
  t.mock.method(chromium, "launchPersistentContext", async () => context);
  await store.update((state) => { state.auth = { status: "ready", confirmedAt: "2026-10-13T00:00:00Z" }; });
  assert.equal((await adapter.getAuthStatus()).status, "ready");
  await context.pages()[0].setContent("<button>登录</button>");
  assert.equal((await adapter.getAuthStatus()).status, "login_required");
});
