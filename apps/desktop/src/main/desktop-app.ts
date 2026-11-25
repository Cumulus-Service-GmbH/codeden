import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type DesktopInfo,
  type DesktopUpdateCommand,
  deepLinkPath,
  FORK_BUILD,
  ForkUpdateResult,
  parseDeepLink,
} from "@codeden/contracts";
import { app, dialog, Menu, Notification, shell } from "electron";
import { CHANNELS } from "../shared/channels";
import { ActivityMonitor, type ServerStatus } from "./activity";
import type { LaunchArgs } from "./args";
import { AppBadge } from "./badge";
import { NativeBrowserFeature } from "./browser/feature";
import { type Connection, connect, launchUrl } from "./connection";
import { Diagnostics } from "./diagnostics";
import { exportDiagnostics } from "./diagnostics-menu";
import { armQuitWatchdog, forceExit } from "./exit";
import { registerBridge } from "./ipc";
import { appMenuTemplate } from "./menu";
import { loadAfterReady, waitForServer } from "./recovery";
import { homeFiles } from "./server-plan";
import {
  applyLaunchAtLogin,
  fileLogger,
  KeepAwake,
  launchAtLoginSupported,
  macSigned,
  openedAtLogin,
} from "./system";
import { AppTray } from "./tray";
import { trayView } from "./tray-view";
import { UpdateController } from "./updates/controller";
import { type ForkCandidate, findForkUpdate } from "./updates/fork-release";
import { stageForkUpdate } from "./updates/fork-stage";
import { resultFile, startForkWorker, updateLock } from "./updates/fork-worker";
import { quitAction, standaloneAction, updateSupport } from "./updates/policy";
import { loadUpdater, waitForRunnerExit } from "./updates/updater";
import { MainWindow } from "./window";
import { windowShot } from "./window-shot";

const DOCS_URL = "https://github.com/leonvanzyl/codeden/blob/main/docs/desktop.md";
/** Longest a quit may take (browser hand-off 15 s + server stop up to 30 s) before it's forced. */
const QUIT_LIMIT_MS = 45_000;

type QuitInitiator =
  | "menu"
  | "tray"
  | "window"
  | "server-stop"
  | "server-crash"
  | "startup"
  | "system";

/**
 * The desktop app (§17): one window on the server's UI, a tray with live counts, the app
 * badge, keep-awake, native notifications and folder picking, `codeden://` links and updates
 * from GitHub Releases. It starts the server (or attaches to a running one for the same home)
 * and leaves the runner running when it quits, as `codeden` does.
 */
export class DesktopApp {
  private readonly log: (message: string) => void;
  private readonly dist = import.meta.dirname;
  private window!: MainWindow;
  private tray!: AppTray;
  private badge!: AppBadge;
  private readonly keepAwake = new KeepAwake();
  private updateProbe =
    FORK_BUILD &&
    typeof process.send === "function" &&
    process.env.CODEDEN_FORK_UPDATE_PROBE === "1";
  private updates!: UpdateController;
  private browser!: NativeBrowserFeature;
  private monitor: ActivityMonitor | undefined;
  private conn: Connection | undefined;
  private status: ServerStatus = { connected: false, activity: null, settings: null };
  private pendingPath: string | null = null;
  private loaded = false;
  private quitting = false;
  private quitInitiator: QuitInitiator = "system";
  private readonly diagnostics: Diagnostics;
  private uiLoad: Connection | undefined;
  private connecting = false;
  private quitReady = false;
  private standaloneTimer: NodeJS.Timeout | undefined;

  /** True once a quit has started (startup errors after that are part of quitting). */
  get isQuitting(): boolean {
    return this.quitting;
  }
  private notifiedUpdate: string | null = null;

  constructor(private readonly args: LaunchArgs) {
    const { logs } = homeFiles(args.home);
    this.log = fileLogger(join(logs, "desktop.log"));
    this.diagnostics = new Diagnostics(join(logs, "desktop-diagnostics.json"));
    if (args.deepLink) this.pendingPath = this.pathFor(args.deepLink);
  }

  private asset(name: string): string {
    return join(this.dist, "assets", name);
  }

  async start(): Promise<void> {
    this.log(`app: CodeDen ${app.getVersion()} starting (home ${this.args.home})`);
    const unsupported = FORK_BUILD
      ? app.isPackaged && process.platform === "darwin"
        ? null
        : "Fork updates install from the packaged macOS app."
      : updateSupport({
          packaged: app.isPackaged,
          platform: process.platform,
          // `CodeDen.app/Contents/Resources/app` -> `CodeDen.app`.
          macSigned: await macSigned(join(app.getAppPath(), "..", "..", "..")),
        });
    this.updates = new UpdateController({
      current: app.getVersion(),
      unsupported,
      ...(FORK_BUILD
        ? {
            fork: {
              check: findForkUpdate,
              arch: process.arch,
              apply: (candidate) => this.applyForkUpdate(candidate),
            },
            result: await this.readForkResult(),
          }
        : {}),
      updater: () => loadUpdater(this.log),
      beforeInstall: () => this.prepareInstall(),
      log: this.log,
    });
    this.updates.onChange((state) => {
      this.conn?.server?.send({ type: "update.state", state });
      this.refresh();
      this.notifyUpdate();
    });

    app.on("child-process-gone", (_event, details) => {
      this.log(
        `app: ${details.type} child exited (code ${details.exitCode}, reason ${details.reason})`,
      );
      this.diagnostics.record({
        kind: "child-exit",
        reason: details.reason,
        code: details.exitCode,
      });
    });
    if (this.updateProbe) {
      delete process.env.CODEDEN_FORK_UPDATE_PROBE;
      process.once("disconnect", () => {
        this.updateProbe = false;
      });
      process.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "fork-update-result" &&
          "result" in message
        ) {
          const result = ForkUpdateResult.safeParse(message.result);
          if (result.success) this.updates.setResult(result.data);
          return;
        }
        if (message !== "fork-update-shutdown" || this.quitting) return;
        void this.stopForkProbe();
      });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(this.menu()));
    this.tray = new AppTray(
      this.asset(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"),
      {
        open: () => this.show(),
        openInbox: () => this.navigate("/inbox"),
        update: (command) => void this.runUpdate(command),
        quit: () => this.quit("tray"),
      },
    );
    this.window = new MainWindow({
      preload: join(this.dist, "preload.cjs"),
      icon: this.asset("icon.png"),
      stateFile: join(homeFiles(this.args.home).desktop, "window-state.json"),
      show: !this.args.hidden && !openedAtLogin(),
      hideOnClose: () => this.status.settings?.desktop.closeToTray ?? true,
      quit: () => this.quit("window"),
      onRendererGone: (details, retry) => {
        this.diagnostics.record({
          kind: "renderer-exit",
          reason: details.reason,
          code: details.exitCode,
        });
        if (this.uiLoad === this.conn) return;
        this.loaded = false;
        if (retry) void this.loadUi();
        else void this.window.showRecovery();
      },
      log: this.log,
    });
    this.badge = new AppBadge(() => this.window.window, this.asset("badge.png"));
    this.browser = new NativeBrowserFeature({ window: () => this.window.window, log: this.log });
    registerBridge({
      info: () => this.info(),
      origin: () => this.window.serverOrigin,
      window: () => this.window.window,
      showWindow: () => this.show(),
      setBadge: (count) => this.badge.set(count),
      icon: this.asset("icon.png"),
      log: this.log,
      browser: this.browser.browsers,
    });
    this.exposeForTests();
    await this.open();
  }

  /** Connect to (or start) the server and load the UI. */
  private async open(): Promise<void> {
    if (this.connecting || this.quitting) return;
    this.connecting = true;
    try {
      this.conn = await connect({
        args: this.args,
        serverEntry: join(this.dist, "server.js"),
        onUpdateCommand: (id, command, version) => void this.onServerCommand(id, command, version),
        onExit: (exit) => this.diagnostics.record({ kind: "server-exit", ...exit }),
        onUnexpectedExit: (code) => {
          void this.onServerExit(code).catch(() => {
            this.log("app: server restart failed");
            return this.window.showRecovery();
          });
        },
        log: this.log,
      });
    } catch (error) {
      this.log(`app: no server: ${String(error)}`);
      if (this.updateProbe) {
        this.quit("server-crash");
        return;
      }
      await dialog.showMessageBox({
        type: "error",
        title: "CodeDen could not start",
        message: "CodeDen could not start its server.",
        detail: `${error instanceof Error ? error.message : String(error)}\n\nSee ${homeFiles(this.args.home).logs}.`,
      });
      await this.window.showRecovery();
      return;
    } finally {
      this.connecting = false;
    }
    if (this.quitting) {
      await this.conn.server?.stop({ stopRunner: this.updateProbe });
      return;
    }
    this.conn.server?.send({ type: "update.state", state: this.updates.state });
    if (this.updateProbe && process.send && this.conn.server?.pid) {
      process.send({
        type: "fork-update-ready",
        pid: this.conn.server.pid,
        port: Number(new URL(this.conn.url).port),
      });
    }
    this.browser.connect(this.conn);

    this.monitor?.stop();
    this.monitor = new ActivityMonitor({
      baseUrl: this.conn.url,
      token: this.conn.token,
      onChange: (status) => this.onStatus(status),
    });
    this.monitor.start();
    if (!this.conn.server) this.startStandaloneUpdates();
    await this.loadUi();
  }

  private async loadUi(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.quitting || this.uiLoad === conn) return;
    this.uiLoad = conn;
    const pendingPath = this.pendingPath;
    const load = async () => {
      if (this.quitting || this.conn !== conn) return;
      await this.window.load(launchUrl(conn, pendingPath ?? "/"));
    };
    try {
      await loadAfterReady(load, () =>
        waitForServer(conn.url, () => !this.quitting && this.conn === conn),
      );
      if (this.quitting || this.conn !== conn) return;
      this.loaded = true;
      const nextPath = this.pendingPath;
      this.pendingPath = null;
      if (nextPath && nextPath !== pendingPath) this.navigate(nextPath);
    } catch (error) {
      if (this.quitting || this.conn !== conn) return;
      this.log(`app: UI navigation failed: ${String(error)}`);
      this.loaded = false;
      await this.window.showRecovery();
    } finally {
      if (this.uiLoad === conn) this.uiLoad = undefined;
    }
  }

  private quit(reason: QuitInitiator): void {
    if (this.quitting) return;
    this.quitInitiator = reason;
    app.quit();
  }

  startupFailed(): void {
    this.log("app: quit initiated by startup failure");
    this.diagnostics.record({ kind: "quit", reason: "startup" });
    forceExit(1);
  }

  show(): void {
    this.window?.show();
  }

  /** A second launch (or a `codeden://` link on Windows and Linux) focuses this instance. */
  secondInstance(args: LaunchArgs): void {
    if (args.deepLink) this.openLink(args.deepLink);
    else if (!args.hidden) this.show();
  }

  openLink(url: string): void {
    const path = this.pathFor(url);
    if (!path) return;
    if (this.loaded) this.navigate(path);
    else this.pendingPath = path;
  }

  private pathFor(url: string): string | null {
    const target = parseDeepLink(url);
    if (!target) this.log(`app: ignored link ${url.slice(0, 200)}`);
    return target ? deepLinkPath(target) : null;
  }

  private navigate(path: string): void {
    this.show();
    if (this.loaded) this.window.window.webContents.send(CHANNELS.navigate, path);
    else this.pendingPath = path;
  }

  /** Quitting: install a downloaded update on the way out, else leave the runner running. */
  beforeQuit(event: Electron.Event): void {
    if (this.quitReady) return;
    event.preventDefault();
    if (this.quitting) return;
    this.quitting = true;
    this.log(`app: quit initiated by ${this.quitInitiator}`);
    this.diagnostics.record({ kind: "quit", reason: this.quitInitiator });
    // Every step below is bounded, but quitting must finish even if one isn't: a timer here,
    // and a separate process for when the main thread itself is stuck in native shutdown.
    const watchdog = setTimeout(() => {
      this.log(`app: still quitting after ${QUIT_LIMIT_MS / 1000} s; exiting now`);
      forceExit(0);
    }, QUIT_LIMIT_MS);
    const hardStop = armQuitWatchdog(QUIT_LIMIT_MS + 5_000, this.log);
    void (async () => {
      try {
        this.window?.allowClose();
        clearInterval(this.standaloneTimer);
        this.monitor?.stop();
        this.keepAwake.set(false);
        // Open session browsers move to the runner's Chromium before the views go.
        await this.browser?.quit();
        if (!FORK_BUILD && this.updates && quitAction(this.updates.state.phase) === "install") {
          // Installing drains the runner first (up to 90 s); the installer ends the app.
          clearTimeout(watchdog);
          hardStop.cancel();
          await this.updates.installOnQuit();
          return;
        }
        await this.conn?.server?.stop({ stopRunner: this.updateProbe });
        this.tray?.destroy();
      } catch (error) {
        // A failed step must not leave the app unable to quit.
        this.log(`app: while quitting: ${String(error)}`);
      }
      this.quitReady = true;
      app.quit();
    })();
  }

  private async stopForkProbe(): Promise<void> {
    try {
      if (this.conn?.server) await this.drainForForkUpdate();
    } catch (error) {
      this.log(`updates: rollback drain failed: ${String(error)}`);
    } finally {
      this.quit("system");
    }
  }

  private async readForkResult(): Promise<ForkUpdateResult | undefined> {
    try {
      return ForkUpdateResult.parse(JSON.parse(await readFile(resultFile(this.args.home), "utf8")));
    } catch {
      return undefined;
    }
  }

  private async drainForForkUpdate(): Promise<void> {
    const server = this.conn?.server;
    if (!server) throw new Error("Fork updates require CodeDen's own desktop server");
    this.monitor?.stop();
    await this.browser.quit();
    await server.stop({ stopRunner: true, timeoutMs: 90_000 });
  }

  private async applyForkUpdate(candidate: ForkCandidate): Promise<void> {
    if (this.quitting || !this.conn?.server || this.args.fake) {
      throw new Error("Start the installed app with its own server to apply a fork update");
    }
    const live = join(app.getAppPath(), "..", "..", "..");
    const verifier = join(this.dist, "fork-signature");
    const lock = updateLock(live);
    const port = Number(new URL(this.conn.url).port);
    await mkdir(lock, { mode: 0o700 });
    let staging: Awaited<ReturnType<typeof stageForkUpdate>> | undefined;
    let worker: Awaited<ReturnType<typeof startForkWorker>> | undefined;
    try {
      staging = await stageForkUpdate(live, verifier, candidate);
      if (this.quitting) throw new Error("CodeDen is already quitting");
      worker = await startForkWorker(join(this.dist, "fork-update-worker.js"), {
        ...staging,
        live,
        home: this.args.home,
        oldPid: process.pid,
        port,
      });
      await this.drainForForkUpdate();
      if (this.quitting) throw new Error("CodeDen is already quitting");
      const child = worker;
      await new Promise<void>((resolve, reject) => {
        child.send("apply", (error) => (error ? reject(error) : resolve()));
      });
      child.disconnect();
      child.unref();
      this.quit("system");
    } catch (error) {
      if (worker?.connected) worker.disconnect();
      if (staging) await rm(staging.work, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
  }

  /** Before the installer runs: stop the server and drain the runner (as `codeden stop`). */
  private async prepareInstall(): Promise<void> {
    this.log("app: preparing to quit for an update");
    this.diagnostics.record({ kind: "quit", reason: "update" });
    this.window.allowClose();
    this.monitor?.stop();
    const server = this.conn?.server;
    if (server) {
      await server.stop({ stopRunner: true, timeoutMs: 90_000 });
      await waitForRunnerExit(homeFiles(this.args.home).runnerLock, 15_000, this.log);
    }
    this.quitReady = true;
  }

  private async onServerCommand(
    id: string,
    command: DesktopUpdateCommand,
    version?: string,
  ): Promise<void> {
    let error: string | null = null;
    try {
      await this.updates.run(command, version);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.conn?.server?.send({ type: "update.done", id, error });
  }

  private async runUpdate(command: DesktopUpdateCommand, version?: string): Promise<void> {
    await this.updates
      .run(command, version)
      .catch((e: unknown) => this.log(`updates: ${String(e)}`));
  }

  private async onServerExit(code: number | null): Promise<void> {
    if (this.quitting) return;
    if (this.updateProbe) {
      this.quit("server-crash");
      return;
    }
    this.loaded = false;
    this.conn = undefined;
    this.monitor?.stop();
    if (code === 0) {
      // Stopped on purpose (`codeden stop` from a terminal): quit with it.
      this.log("app: the server was stopped; quitting");
      this.quit("server-stop");
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "CodeDen",
      message: "The CodeDen server stopped unexpectedly.",
      detail: `Agents keep running in the runner. See ${homeFiles(this.args.home).logs}.`,
      buttons: ["Restart", "Quit"],
      defaultId: 0,
    });
    if (this.quitting) return;
    if (response === 0) await this.open();
    else this.quit("server-crash");
  }

  private onStatus(status: ServerStatus): void {
    this.status = status;
    const desktop = status.settings?.desktop;
    if (desktop) applyLaunchAtLogin(desktop.launchAtLogin);
    const running = status.activity?.running ?? 0;
    this.keepAwake.set(Boolean(desktop?.keepAwake ?? true) && running > 0);
    this.refresh();
  }

  private refresh(): void {
    if (!this.tray || !this.updates) return;
    const view = trayView({
      activity: this.status.activity,
      connected: this.status.connected,
      update: this.updates.state,
      fork: FORK_BUILD,
      autoUpdate: this.status.settings?.updates.mode === "auto",
    });
    this.tray.update(view);
    if (this.status.connected) this.badge?.set(view.badge);
  }

  /** Attached to a server started by `codeden`: follow the update mode here (§17). */
  private startStandaloneUpdates(): void {
    const tick = () => {
      const settings = this.status.settings;
      if (!settings) return;
      const state = this.updates.state;
      const action = standaloneAction({
        mode: FORK_BUILD && settings.updates.mode === "auto" ? "notify" : settings.updates.mode,
        phase: state.phase,
        unsupported: state.unsupported,
        checkedAt: state.checkedAt ? Date.parse(state.checkedAt) : null,
        now: Date.now(),
      });
      if (action) void this.runUpdate(action);
    };
    this.standaloneTimer = setInterval(tick, 60_000);
    setTimeout(tick, 5_000).unref();
  }

  /** Without our own server there is no update banner: say it with a notification. */
  private notifyUpdate(): void {
    const state = this.updates.state;
    if (FORK_BUILD || this.conn?.server !== null || !Notification.isSupported() || !state.latest)
      return;
    if (state.phase !== "available" && state.phase !== "downloaded") return;
    const key = `${state.phase}:${state.latest}`;
    if (this.notifiedUpdate === key) return;
    this.notifiedUpdate = key;
    new Notification({
      title: `CodeDen ${state.latest} is ${state.phase === "downloaded" ? "ready" : "available"}`,
      body:
        state.phase === "downloaded"
          ? "It installs when you quit CodeDen, or choose Restart to update in the tray menu."
          : "Download it from the tray menu.",
    }).show();
  }

  private info(): DesktopInfo {
    return {
      version: app.getVersion(),
      platform: process.platform as DesktopInfo["platform"],
      packaged: app.isPackaged,
      ownsServer: Boolean(this.conn?.server),
      launchAtLoginSupported,
      nativeBrowser: true,
    };
  }

  private menu() {
    return appMenuTemplate(process.platform, {
      openSettings: () => this.navigate("/settings/general"),
      openInbox: () => this.navigate("/inbox"),
      checkForUpdates: () => {
        this.navigate("/settings/about");
        void this.runUpdate("check");
      },
      openDocs: () => void shell.openExternal(DOCS_URL),
      openLogs: () => void shell.openPath(homeFiles(this.args.home).logs),
      exportDiagnostics: () => void exportDiagnostics(this.diagnostics),
      retryLoading: () => {
        const retry = this.conn ? this.loadUi() : this.open();
        void retry.catch(() => this.log("app: could not retry loading the UI"));
      },
      quit: () => this.quit("menu"),
      zoom: (command) => {
        this.window?.zoom(command);
        this.browser?.browsers.layout();
      },
    });
  }

  /** Read-only hooks for the desktop smoke test (`CODEDEN_DESKTOP_TEST=1`). */
  private exposeForTests(): void {
    if (process.env.CODEDEN_DESKTOP_TEST !== "1") return;
    (globalThis as Record<string, unknown>).__codedenDesktopTest = {
      trayLabels: () => this.tray.menuLabels(),
      status: () => this.status,
      ownsServer: () => Boolean(this.conn?.server),
      serverPid: () => this.conn?.server?.pid ?? null,
      keepAwake: () => this.keepAwake.active,
      updateState: () => this.updates.state,
      zoomFactor: () => this.window.zoomFactor,
      nativeViews: () => this.browser.browsers.views(),
      windowShot: () => windowShot(this.window.window),
    };
  }
}
