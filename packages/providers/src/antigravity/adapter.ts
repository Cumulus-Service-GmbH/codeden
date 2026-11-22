import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import { findOption, modeIds } from "../acp/config";
import { classifyAcpError } from "../acp/errors";
import type { AcpAgentSpec } from "../acp/extensions";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpSession } from "../acp/session";
import { type ProviderAdapter, type ProviderSession, ProviderSessionError } from "../adapter";
import { ModelCatalog } from "../models";
import { brokenInstallMessage, lookupForDetect } from "../util/detect-exe";
import type { ResolvedCommand } from "../util/exec";
import { findExecutable, type LocateOptions } from "../util/locate";
import {
  ANTIGRAVITY_LOGIN_COMMAND,
  antigravityInstallCommand,
  antigravityTooOldMessage,
  detectAntigravity,
  isSupportedAntigravityVersion,
} from "./detect";
import { antigravityModelInfos, fallbackAntigravityModels, thoughtLevel } from "./models";
import { ANTIGRAVITY_ACP_ARGS, type AntigravityProbe, probeAntigravity } from "./probe";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/**
 * How CodeDen drives `agy acp --process-per-session`. No `authMethod`: the ACP server reuses
 * the login of an interactive `agy`, so CodeDen never authenticates. Agent sessions run in its
 * `default` mode, which asks before edits and commands; there is no read-only mode, so
 * read-only sessions stay in `default` and CodeDen's policy refuses edits and commands. Plan
 * mode is its `plan` mode. CodeDen's reasoning effort is its `thought_level` option
 * (`thoughtLevel`: `minimal` runs at `low`, a level a model lacks at the nearest one it has).
 */
export const ANTIGRAVITY_AGENT: AcpAgentSpec = {
  label: "Antigravity CLI",
  args: ANTIGRAVITY_ACP_ARGS,
  modes: { agent: "default", plan: "plan" },
  effort: { category: "thought_level", value: thoughtLevel },
};

/**
 * Honest flags (Principle 5). Approvals and the read-only level go through the CLI's permission
 * requests, decided by CodeDen's policy for every call (so autonomy changes apply live). Plan
 * mode is its `plan` mode; resume is `session/load`; reasoning effort is its thinking level.
 * Skills: the CLI loads its own, from `~/.gemini/config/skills/<name>/`, in every session.
 * Not wired up: questions, steering (ACP can't add input to a running prompt), subagents,
 * rollback and fork. Images and MCP servers (CodeDen's tools are an HTTP MCP server) follow
 * what the CLI reports in `initialize`; plan mode, what its sessions list.
 */
const BASE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: false,
  rollback: false,
  fork: false,
  images: true,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  liveAutonomy: true,
  readOnly: true,
};

export interface AntigravityAdapterOptions {
  executable?: ResolvedCommand;
  /** Where to look for the CLI (tests); default PATH, then `~/.local/bin`. */
  locate?: LocateOptions;
  /** Max time the probe's throwaway session may take to list the models (tests). */
  listTimeoutMs?: number;
  /** Max time for a probe (detection). */
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

/** The Antigravity CLI through its ACP server (`agy acp`), one process per session (§7.2). */
export class AntigravityAdapter implements ProviderAdapter {
  readonly id = ANTIGRAVITY_PROVIDER_ID;
  readonly displayName = "Antigravity CLI";
  private readonly catalog = new ModelCatalog(fallbackAntigravityModels());
  private info: AcpInitializeResult | undefined;
  /** Whether the last session listed a `plan` mode; unknown until one has. */
  private planListed: boolean | undefined;
  private detecting: Promise<ProviderStatus> | undefined;
  private found: { command: ResolvedCommand; version: string | null } | undefined;

  constructor(private readonly options: AntigravityAdapterOptions = {}) {}

  /**
   * The CLI to run: the one detection found, else one looked up now for this session only (only
   * detection fills the cache, so a session's lookup never replaces a newer detection's).
   */
  private async executable(): Promise<{ command: ResolvedCommand; version: string | null }> {
    if (this.found) return this.found;
    const given = this.options.executable;
    if (given) {
      // A given copy is version-checked like a found one before a session runs it.
      const lookup = await lookupForDetect("agy", {
        executable: given,
        ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      });
      if (!lookup.command) throw new Error(brokenInstallMessage("Antigravity CLI", lookup.broken));
      return { command: given, version: lookup.version };
    }
    const lookup = await findExecutable("agy", {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      ...this.options.locate,
    });
    if (!lookup.command) {
      throw new Error("The Antigravity CLI is not installed (no `agy` on PATH or in ~/.local/bin)");
    }
    return { command: lookup.command, version: lookup.version };
  }

  /** One detection at a time: a call while one runs shares its result. */
  detect(): Promise<ProviderStatus> {
    this.detecting ??= this.runDetection().finally(() => {
      this.detecting = undefined;
    });
    return this.detecting;
  }

  private runDetection(): Promise<ProviderStatus> {
    // A reinstall or an uninstall since the last detection: look again.
    this.found = undefined;
    return detectAntigravity({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.locate ? { locate: this.options.locate } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      probe: (exe, version) => this.probe(exe, version),
    });
  }

  /** What the CLI reported in `initialize` refines resume, images and MCP; sessions, plan mode. */
  capabilities(): ProviderCapabilities {
    const caps = this.info?.agentCapabilities;
    return {
      ...BASE_CAPABILITIES,
      ...(caps
        ? {
            resume: caps.loadSession === true,
            images: caps.promptCapabilities?.image === true,
            mcp: caps.mcpCapabilities?.http === true,
          }
        : {}),
      ...(this.planListed === false ? { planMode: false } : {}),
    };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  /**
   * The CLI lists its models only in a session, so there is no `refreshModels`: detection's probe
   * opens a throwaway one to read them, real sessions refresh them, and Default stands
   * in until one of them reports the account's list.
   */
  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const { command, version } = await this.executable();
    if (!isSupportedAntigravityVersion(version)) {
      throw new ProviderSessionError(
        "version_unsupported",
        `${antigravityTooOldMessage(version)}. Update it with \`${antigravityInstallCommand()}\`.`,
        "setup",
      );
    }
    const session = new AcpSession(opts, {
      executable: command,
      spec: ANTIGRAVITY_AGENT,
      onInfo: (info) => this.onInfo(info),
      onSetup: (setup) => this.applySetup(setup),
      ...(this.options.startTimeoutMs ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
      ...(this.options.interruptTimeoutMs
        ? { interruptTimeoutMs: this.options.interruptTimeoutMs }
        : {}),
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw signInError(error);
    }
    return session;
  }

  /** A handshake (a session's or the probe's) arrived: its capabilities are the newest. */
  private onInfo(info: AcpInitializeResult): void {
    this.info = info;
  }

  /**
   * The newest complete snapshot wins: a setup replaces the models and modes shown, taken whole
   * with nothing merged, when it lists models. Probes and sessions report the moment their
   * reply arrives, so the last one to arrive is the newest. An empty or malformed one changes
   * nothing.
   */
  private applySetup(setup: AcpSessionSetup): void {
    try {
      const models = antigravityModelInfos(setup);
      if (!models) return;
      // A snapshot that says which modes it has (even none) decides plan mode; one that
      // doesn't leaves it as it was.
      if (setup.modes !== undefined || findOption(setup.configOptions, "mode")) {
        this.planListed = modeIds(setup).includes(ANTIGRAVITY_AGENT.modes.plan ?? "plan");
      }
      this.catalog.set(models);
    } catch {
      // A malformed reply: Default (or the last good list) stands.
    }
  }

  /** Detection found a supported copy: sessions run it, after the handshake shows its flags. */
  private probe(exe: ResolvedCommand, version: string | null): Promise<AntigravityProbe> {
    this.found = { command: exe, version };
    return probeAntigravity(exe, {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      ...(this.options.listTimeoutMs ? { setupTimeoutMs: this.options.listTimeoutMs } : {}),
      onInfo: (info) => this.onInfo(info),
      onSetup: (setup) => this.applySetup(setup),
    });
  }
}

/** A session that couldn't start because the CLI isn't signed in says how to sign in. */
function signInError(error: unknown): unknown {
  if (classifyAcpError(error) !== "auth") return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderSessionError(
    "not_logged_in",
    `The Antigravity CLI is not signed in (${message.replace(/\.$/, "")}). Run \`${ANTIGRAVITY_LOGIN_COMMAND}\` once and sign in.`,
    "auth",
  );
}
