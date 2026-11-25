import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { ForkUpdateResult } from "@codeden/contracts";
import { homeFiles, isProcessAlive, readToken } from "../server-plan";
import { verifyForkHealth } from "./fork-health";
import { replaceApp } from "./fork-transaction";

export interface ForkHandoff {
  live: string;
  staged: string;
  work: string;
  home: string;
  oldPid: number;
  port: number;
  version: string;
  commit: string;
}

export const resultFile = (home: string) =>
  join(homeFiles(home).desktop, "fork-update-result.json");
export const updateLock = (live: string) => join(dirname(live), ".codeden-fork-update.lock");

export async function startForkWorker(entry: string, handoff: ForkHandoff) {
  const child = spawn(process.execPath, [entry, JSON.stringify(handoff)], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await spawned(child);
  return child;
}

function spawned(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function waitUntil(predicate: () => Promise<boolean>, message: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function pidAt(path: string): Promise<number | null> {
  try {
    const { pid } = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid CodeDen process lock");
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function bundleIdle(h: ForkHandoff) {
  for (const path of [homeFiles(h.home).serverLock, homeFiles(h.home).runnerLock]) {
    const pid = await pidAt(path);
    if (pid && isProcessAlive(pid)) return false;
  }
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axww", "-o", "pid=,comm="], {
    timeout: 2_000,
  });
  return !stdout.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[1]) !== process.pid && match[2]?.startsWith(`${h.live}/`);
  });
}

export async function runForkWorker(h: ForkHandoff) {
  const report = async (result: ForkUpdateResult) => {
    const file = resultFile(h.home);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(result), { mode: 0o600 });
    await rename(temp, file);
    if (launched?.connected) launched.send({ type: "fork-update-result", result }, () => {});
  };
  let launched: ChildProcess | undefined;
  let ownedServer: { pid: number; port: number } | undefined;
  const start = async (probe: boolean) => {
    const child = spawn(
      join(h.live, "Contents", "MacOS", "CodeDen"),
      ["--home", h.home, "--port", String(h.port)],
      {
        detached: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          CODEDEN_FORK_UPDATE_PROBE: probe ? "1" : undefined,
        },
        stdio: ["ignore", "ignore", "ignore", probe ? "ipc" : "ignore"],
      },
    );
    child.on("message", (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "fork-update-ready"
      )
        return;
      if (
        "pid" in message &&
        typeof message.pid === "number" &&
        Number.isSafeInteger(message.pid) &&
        "port" in message &&
        typeof message.port === "number" &&
        Number.isSafeInteger(message.port) &&
        message.port > 0 &&
        message.port <= 65535
      ) {
        ownedServer = { pid: message.pid, port: message.port };
      }
    });
    await spawned(child);
    launched = child;
    return {
      stop: async () => {
        if (child.connected) child.send("fork-update-shutdown", () => {});
        await waitUntil(
          async () =>
            (child.exitCode !== null || child.signalCode !== null) && (await bundleIdle(h)),
          "The failed app or its runner could not stop safely",
        );
        ownedServer = undefined;
      },
    };
  };
  try {
    await waitUntil(
      async () => !isProcessAlive(h.oldPid) && (await bundleIdle(h)),
      "CodeDen or its runner did not exit before the update",
      45_000,
    );
    await replaceApp({
      live: h.live,
      staged: h.staged,
      backup: join(h.work, "CodeDen.backup.app"),
      failed: join(h.work, "CodeDen.failed.app"),
      version: h.version,
      move: rename,
      swap: async (left, right, trusted) => {
        await promisify(execFile)(
          join(trusted, "Contents", "Resources", "app", "dist", "fork-signature"),
          ["--swap", left, right],
          { timeout: 10_000 },
        );
      },
      start,
      health: () =>
        waitUntil(async () => {
          if (!ownedServer || (await pidAt(homeFiles(h.home).serverLock)) !== ownedServer.pid)
            return false;
          const token = readToken(h.home);
          if (!token) return false;
          try {
            await verifyForkHealth(ownedServer.port, token, h.version, h.commit);
            return true;
          } catch {
            return false;
          }
        }, "The new build did not pass its health checks"),
      report,
    });
  } catch (error) {
    // A failed preflight leaves the filesystem untouched. Relaunch only if the old app exited.
    await report({ status: "failed", message: String(error) });
    if (!isProcessAlive(h.oldPid) && (await bundleIdle(h))) await start(false);
  } finally {
    if (launched?.connected) launched.disconnect();
    launched?.unref();
    await rm(updateLock(h.live), { recursive: true, force: true });
  }
}
