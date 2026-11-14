import { z } from "zod";
import { Id } from "./common";

/**
 * Execution backends (`docs/remote-runners.md` §5): where a project's agent sessions run. The
 * server's `ExecutionBackend` makes, starts, stops and removes sandboxes and opens a link to the
 * runner inside one; these are the shapes that cross its boundary and the API.
 */

/**
 * Where a project's new agent sessions run (`Project.execution.backend`):
 * - `local`: worktrees on this machine, run by the home runner (the default);
 * - `docker`: a container of its own per session, with the whole runner inside, cloning the
 *   repository there. Experimental: GitHub projects only, and only providers that need no
 *   credentials (`ProviderCapabilities.credentialFree`) until credentials reach containers.
 */
export const ProjectExecutionBackend = z.enum(["local", "docker"]);
export type ProjectExecutionBackend = z.infer<typeof ProjectExecutionBackend>;

/** A project's execution settings. Defaults to `local`, so projects from before it still parse. */
export const ProjectExecution = z.object({
  backend: ProjectExecutionBackend.default("local"),
});
export type ProjectExecution = z.infer<typeof ProjectExecution>;

/**
 * Why a backend can or can't be used:
 * - `ok`: it can be used;
 * - `not_found`: its tool isn't installed (no `docker` on PATH);
 * - `daemon_down`: the tool is there but its daemon can't be reached;
 * - `too_old`: the daemon is older than CodeDen supports;
 * - `unsupported_project`: the project can't use it (Docker needs a GitHub project to clone);
 * - `detect_failed`: anything else; `reason` says what.
 */
export const BackendStatusCode = z.enum([
  "ok",
  "not_found",
  "daemon_down",
  "too_old",
  "unsupported_project",
  "detect_failed",
]);
export type BackendStatusCode = z.infer<typeof BackendStatusCode>;

/** Whether a backend is available on this machine, with the reason and the fix when not. */
export const BackendStatus = z.object({
  backend: ProjectExecutionBackend,
  available: z.boolean(),
  code: BackendStatusCode,
  /** The backend's version (Docker Engine's), when known. */
  version: z.string().nullable(),
  /** Why it isn't available, safe to show; null when it is. */
  reason: z.string().nullable(),
  /** What the user can do about it; null when there is nothing to do. */
  fix: z.string().nullable(),
});
export type BackendStatus = z.infer<typeof BackendStatus>;

/** `GET /api/execution/backends`: every backend and whether it can be used now. */
export const ExecutionBackendsResponse = z.object({ backends: z.array(BackendStatus) });
export type ExecutionBackendsResponse = z.infer<typeof ExecutionBackendsResponse>;

/** What to make a sandbox for: one agent session's runner (`ExecutionBackend.provision`). */
export const SandboxSpec = z.object({
  /** The runner record the sandbox serves (`runners.id`). */
  recordId: Id,
  sessionId: Id,
  projectId: Id,
  /** The image to run, e.g. `codeden-runner:0.7.2`. */
  image: z.string().min(1),
  /** CPU limit, in CPUs. */
  cpus: z.number().positive(),
  /** Memory limit, in MiB. */
  memoryMb: z.int().positive(),
  /** Load the scripted Fake provider in the sandbox's runner (development and tests). */
  fake: z.boolean().default(false),
});
export type SandboxSpec = z.infer<typeof SandboxSpec>;

/**
 * The backend's handle on a sandbox. Holds names only, never a credential. The runner record
 * keeps the container's name (`RunnerRecord.sandboxRef`), from which the backend finds the rest
 * again after a server restart (`sandboxRefFor`).
 */
export const SandboxRef = z.object({
  backend: z.literal("docker"),
  /** The container's name. */
  container: z.string().min(1),
  /** The named volume holding the runner's home and its clones. */
  volume: z.string().min(1),
});
export type SandboxRef = z.infer<typeof SandboxRef>;

/** The named volume of a Docker sandbox, from its container's name. */
export function sandboxVolumeName(container: string): string {
  return `${container}-data`;
}

/** A Docker sandbox's reference from the container name kept on its runner record. */
export function sandboxRefFor(container: string): SandboxRef {
  return { backend: "docker", container, volume: sandboxVolumeName(container) };
}

/**
 * A sandbox's state: `running`, `exited` (stopped or crashed; `start` brings it back) or
 * `other` (being created, paused, restarting, dead).
 */
export const SandboxState = z.enum(["running", "exited", "other"]);
export type SandboxState = z.infer<typeof SandboxState>;

/** One of this install's sandboxes, as `ExecutionBackend.list` finds them by their labels. */
export const SandboxSummary = z.object({
  container: z.string().min(1),
  volume: z.string().nullable(),
  sessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  /** The runner record it serves. */
  recordId: z.string().nullable(),
  /** The CodeDen version it was made by. */
  version: z.string().nullable(),
  state: SandboxState,
});
export type SandboxSummary = z.infer<typeof SandboxSummary>;
