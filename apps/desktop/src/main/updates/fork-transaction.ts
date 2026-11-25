import type { ForkUpdateResult } from "@codeden/contracts";

interface Transaction {
  live: string;
  staged: string;
  backup: string;
  failed: string;
  version: string;
  move(from: string, to: string): Promise<void>;
  swap(from: string, to: string, trustedBundle: string): Promise<void>;
  start(probe: boolean): Promise<{ stop(): Promise<void> }>;
  health(): Promise<void>;
  report(result: ForkUpdateResult): Promise<void>;
}

/** Keep the prior bundle until the newly launched app proves its health. */
export async function replaceApp(t: Transaction): Promise<void> {
  let swapped = false;
  let candidate: Awaited<ReturnType<Transaction["start"]>> | undefined;
  try {
    await t.move(t.staged, t.backup);
    await t.swap(t.live, t.backup, t.live);
    swapped = true;
    candidate = await t.start(true);
    await t.health();
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    try {
      await candidate?.stop();
      if (swapped) {
        await t.swap(t.live, t.backup, t.backup);
        // The live bundle is already restored even if preserving the failed build fails.
        await t.move(t.backup, t.failed).catch(() => {});
      }
    } catch (rollbackError) {
      await t.report({
        status: "failed",
        message: `Update failed: ${failure}. Restore failed: ${String(rollbackError)}. Backup: ${t.backup}`,
      });
      return;
    }
    await t.report({
      status: swapped ? "restored" : "failed",
      message: `Update failed: ${failure}.${swapped ? " The previous app was restored." : ""}`,
    });
    try {
      await t.start(false);
    } catch (relaunchError) {
      await t.report({
        status: "failed",
        message: `Previous app could not relaunch: ${String(relaunchError)}`,
      });
    }
    return;
  }
  await t.report({ status: "installed", message: `CodeDen updated to ${t.version}.` });
}
