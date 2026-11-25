import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type DiskHygieneCommand,
  DiskHygieneConfig,
  type DiskHygieneReport,
  DiskHygieneStatus,
  isNewerVersion,
} from "@codeden/contracts";
import { Cron } from "croner";
import { readJsonFile, writeJsonFile } from "../../json-file";
import { conflict } from "../errors";
import { type SweepDeps, sweep } from "./sweep";

export class DiskHygiene {
  private readonly file: string;
  private state: DiskHygieneStatus;
  private task?: Promise<void>;
  private nightly?: Cron;

  constructor(
    private readonly deps: SweepDeps,
    private readonly masterEnabled: () => boolean,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.file = join(deps.home, "disk-hygiene.json");
    const parsed = DiskHygieneStatus.safeParse(readJsonFile(this.file));
    this.state = parsed.success
      ? parsed.data
      : {
          version: deps.version,
          config: DiskHygieneConfig.parse({}),
          previewId: null,
          approved: false,
          report: null,
          history: [],
        };
  }

  status(): DiskHygieneStatus {
    if (this.state.version === this.deps.version) return this.state;
    return { ...this.state, version: this.deps.version, previewId: null, approved: false };
  }

  private save(state: DiskHygieneStatus) {
    writeJsonFile(this.file, state, 0o600);
    this.state = state;
  }

  start() {
    const updated = isNewerVersion(this.deps.version, this.state.version);
    if (updated && this.state.config.enabled && this.masterEnabled()) {
      this.scheduled("update");
    } else if (this.state.version !== this.deps.version || !readJsonFile(this.file)) {
      this.save(this.status());
    }
    this.nightly = new Cron("0 2 * * *", () => this.scheduled("nightly"));
  }

  async stop() {
    this.nightly?.stop();
    await this.task?.catch(() => {});
  }

  private scheduled(trigger: "nightly" | "update") {
    if (!this.masterEnabled() || !this.state.config.enabled || this.task) return;
    void this.run(trigger, trigger === "update").catch(() => this.log("Disk hygiene run failed"));
  }

  async command(command: DiskHygieneCommand): Promise<DiskHygieneStatus> {
    if (this.task) throw conflict("A disk hygiene run is already in progress");
    const state = this.status();
    switch (command.action) {
      case "configure": {
        const reset =
          state.config.cacheBudgetBytes !== command.config.cacheBudgetBytes ||
          JSON.stringify(state.config.protectPaths) !== JSON.stringify(command.config.protectPaths);
        this.save({
          ...state,
          config: command.config,
          previewId: reset ? null : state.previewId,
          approved: reset ? false : state.approved,
        });
        break;
      }
      case "approve":
        if (
          state.previewId !== command.previewId ||
          state.report?.id !== command.previewId ||
          !state.report.dryRun ||
          state.report.version !== state.version
        ) {
          throw conflict("Review a new dry run for this version before approving");
        }
        this.save({ ...state, approved: true });
        break;
      case "preview":
      case "run":
        await this.run("manual", command.action === "preview" || !this.masterEnabled());
        break;
    }
    return this.status();
  }

  private run(trigger: DiskHygieneReport["trigger"], preview: boolean): Promise<void> {
    const state = this.status();
    const dryRun = preview || state.config.dryRun || !state.approved;
    this.task = Promise.resolve()
      .then(async () => {
        const at = Date.now();
        const scopes = await sweep(this.deps, state.config, dryRun, at);
        const report = {
          id: randomUUID(),
          version: state.version,
          at: new Date(at).toISOString(),
          trigger,
          dryRun,
          scopes,
        };
        this.save({
          ...state,
          report,
          history: state.report ? [state.report, ...state.history].slice(0, 14) : state.history,
          previewId: dryRun ? report.id : state.previewId,
        });
      })
      .finally(() => {
        this.task = undefined;
      });
    return this.task;
  }
}
