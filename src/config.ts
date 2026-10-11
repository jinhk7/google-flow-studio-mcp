import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  browserExecutable: string;
  profileDir: string;
  stateFile: string;
  databaseFile?: string;
  downloadDir?: string;
}

function browserCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const home = os.homedir();
  return [
    process.env.FLOW_BROWSER_EXECUTABLE,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ].filter((value): value is string => Boolean(value));
}

export function loadConfig(cwd = process.cwd()): Config {
  const browserExecutable = browserCandidates().find((candidate) => existsSync(candidate));
  if (!browserExecutable) {
    throw new Error("Chrome or Edge was not found. Install a supported browser or set FLOW_BROWSER_EXECUTABLE to its absolute path.");
  }
  const dataRoot = path.resolve(process.env.FLOW_DATA_DIR ?? path.join(os.homedir(), ".google-flow-creator"));
  return {
    browserExecutable,
    profileDir: path.resolve(process.env.FLOW_PROFILE_DIR ?? path.join(dataRoot, "browser-profile")),
    stateFile: path.resolve(process.env.FLOW_STATE_FILE ?? path.join(dataRoot, "state.json")),
    databaseFile: path.resolve(process.env.FLOW_DATABASE_FILE ?? path.join(dataRoot, "state.sqlite")),
    downloadDir: path.resolve(process.env.FLOW_DOWNLOAD_DIR ?? path.join(dataRoot, "downloads")),
  };
}
