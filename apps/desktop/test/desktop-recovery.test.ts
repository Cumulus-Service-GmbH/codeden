import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connect } from "../src/main/connection";
import { DesktopApp } from "../src/main/desktop-app";
import { ServerProcess } from "../src/main/server-process";

const electron = vi.hoisted(() => ({
  setApplicationMenu: vi.fn<(menu: MenuItemConstructorOptions[]) => void>(),
  showMessageBox: vi.fn<() => Promise<{ response: number }>>(),
  loadURL: vi.fn<(url: string) => Promise<void>>(),
}));
const contents = Object.assign(new EventEmitter(), {
  setWindowOpenHandler: vi.fn(),
  session: {
    webRequest: { onHeadersReceived: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  },
});
vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  return {
    app: {
      getVersion: () => "0.0.0",
      getAppPath: () => "/app",
      getLoginItemSettings: () => ({}),
      on: vi.fn(),
      isPackaged: false,
    },
    dialog: { showMessageBox: electron.showMessageBox },
    Menu: {
      setApplicationMenu: electron.setApplicationMenu,
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
    },
    BrowserWindow: class extends EventEmitter {
      webContents = contents;
      loadURL = electron.loadURL;
      isDestroyed = () => false;
    },
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display },
  };
});
vi.mock("../src/main/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/connection")>()),
  connect: vi.fn(),
}));
vi.mock("../src/main/system", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/system")>()),
  macSigned: async () => false,
}));
vi.mock("../src/main/tray", () => ({ AppTray: class {} }));
vi.mock("../src/main/badge", () => ({ AppBadge: class {} }));
vi.mock("../src/main/ipc", () => ({ registerBridge: vi.fn() }));
vi.mock("../src/main/browser/feature", () => ({
  NativeBrowserFeature: class {
    connect() {}
  },
}));
vi.mock("../src/main/activity", () => ({
  ActivityMonitor: class {
    start() {}
    stop() {}
  },
}));

let home: string;

beforeEach(() => {
  vi.resetAllMocks();
  electron.loadURL.mockResolvedValue(undefined);
  home = mkdtempSync(join(tmpdir(), "codeden-desktop-recovery-"));
});

afterEach(() => {
  contents.removeAllListeners();
  rmSync(home, { recursive: true, force: true });
});

function startApp() {
  return new DesktopApp({ home, port: null, hidden: true, fake: true, deepLink: null }).start();
}

function recoveryPage() {
  return decodeURIComponent(electron.loadURL.mock.lastCall?.[0] ?? "");
}

function rendererExit() {
  contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 });
}

it("keeps the owned server when Retry Loading runs before Restart is accepted", async () => {
  const connected = { url: "http://127.0.0.1:4321", token: "test", version: "0.0.0" };
  const server = new ServerProcess({
    home,
    entry: "unused",
    fake: true,
    logFile: "unused",
    onUnexpectedExit: vi.fn(),
    onUpdateCommand: vi.fn(),
    port: 4321,
    log: vi.fn(),
  });
  vi.mocked(connect).mockResolvedValueOnce({ ...connected, server });
  vi.mocked(connect).mockResolvedValueOnce({ ...connected, server });
  vi.mocked(connect).mockRejectedValue(new Error("unexpected extra connection"));
  await startApp();
  const connection = vi.mocked(connect).mock.calls[0]?.[0];
  const help = electron.setApplicationMenu.mock.lastCall?.[0].find(({ role }) => role === "help");
  const retry = Array.isArray(help?.submenu)
    ? help.submenu.find(({ label }) => label === "Retry Loading CodeDen")?.click
    : undefined;
  if (!connection || !retry) throw new Error("Expected a connection and Help retry action");

  const crashDialog = Promise.withResolvers<{ response: number }>();
  electron.showMessageBox.mockReturnValue(crashDialog.promise);
  connection.onUnexpectedExit(9);
  expect(electron.showMessageBox).toHaveBeenCalledOnce();
  const retried = Promise.withResolvers<void>();
  electron.loadURL.mockImplementationOnce(async () => retried.resolve());
  Reflect.apply(retry, undefined, []);
  await retried.promise;

  crashDialog.resolve({ response: 0 });
  await crashDialog.promise;
  expect(connect).toHaveBeenCalledTimes(2);
});

it("shows the recovery page when the renderer exits during a failed startup", async () => {
  vi.mocked(connect).mockRejectedValue(new Error("startup failed"));
  const prompt = Promise.withResolvers<void>();
  const dismiss = Promise.withResolvers<{ response: number }>();
  electron.showMessageBox.mockImplementation(() => {
    prompt.resolve();
    return dismiss.promise;
  });
  const start = startApp();
  try {
    await prompt.promise;
    rendererExit();
    expect(recoveryPage()).toContain("CodeDen could not load");
  } finally {
    dismiss.resolve({ response: 0 });
    await start;
  }
});

it.each(["linux", "win32", "darwin"])("documents how to reach Help on %s", async (platform) => {
  vi.mocked(connect).mockRejectedValue(new Error("startup failed"));
  electron.showMessageBox.mockImplementation(async () => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    return { response: 0 };
  });
  try {
    await startApp();
  } finally {
    vi.unstubAllGlobals();
  }
  const page = recoveryPage();
  expect(page).toContain("In the Help menu, choose Retry Loading CodeDen or Export Diagnostics.");
  expect(page.includes("Press Alt to show the menu bar.")).toBe(platform !== "darwin");
});
