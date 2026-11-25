import { z } from "zod";
import { FORK_RELEASE_REPOSITORY } from "./fork-build";

/** Receipt published beside each signed macOS update ZIP. */
export const ForkUpdateReceipt = z.strictObject({
  repository: z.literal(FORK_RELEASE_REPOSITORY),
  tag: z.string().regex(/^fork-v\d+\.\d+\.\d+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  artifact: z.string().regex(/^CodeDen-\d+\.\d+\.\d+-(arm64|x64)\.zip$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ForkUpdateReceipt = z.infer<typeof ForkUpdateReceipt>;

/** Metadata for a release that must not enter the download or install pipeline. */
export const UpstreamRelease = z.object({ version: z.string(), url: z.url() });
export type UpstreamRelease = z.infer<typeof UpstreamRelease>;

/** Outcome persisted by the detached worker and shown after relaunch. */
export const ForkUpdateResult = z.object({
  status: z.enum(["installed", "restored", "failed"]),
  message: z.string(),
});
export type ForkUpdateResult = z.infer<typeof ForkUpdateResult>;
