import { join } from "node:path";
import type { Project } from "@codeden/contracts";
import type { Exec } from "../exec";
import { canonical, contains, hygieneEnv } from "./paths";

export class HygieneGit {
  constructor(
    private readonly exec: Exec,
    private readonly cwd: string,
  ) {}

  private git(cwd: string, args: string[], isolated = false) {
    return this.exec(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        ...args,
      ],
      {
        cwd,
        timeoutMs: 15000,
        env: {
          ...hygieneEnv(),
          HOME: isolated ? undefined : process.env.HOME,
          GIT_CONFIG_GLOBAL: isolated
            ? process.platform === "win32"
              ? "NUL"
              : "/dev/null"
            : undefined,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
        },
      },
    );
  }

  async worktrees(project: Project): Promise<string[]> {
    const result = await this.git(project.path, ["worktree", "list", "--porcelain", "-z"]);
    if (result.code !== 0) throw new Error("Could not read registered Git worktrees");
    return result.stdout.split("\0\0").flatMap((record, index) => {
      const first = record.split("\0")[0] ?? "";
      return index > 0 && first.startsWith("worktree ") ? [first.slice(9)] : [];
    });
  }

  async eligibility(project: Project, path: string): Promise<string | null> {
    const status = await this.git(path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored",
      "--ignore-submodules=none",
    ]);
    if (status.code !== 0) return "Could not verify Git status";
    if (status.stdout) return "Uncommitted, untracked or ignored files";
    if (project.kind !== "github") return "Unpushed work could not be ruled out";
    const head = await this.git(path, ["rev-parse", "--verify", "HEAD"]);
    const oid = head.stdout.trim();
    if (head.code !== 0 || !/^[a-f0-9]{40,64}$/.test(oid)) return "Could not verify worktree HEAD";
    const refs = await this.git(path, [
      "for-each-ref",
      "--points-at",
      oid,
      "--format=%(refname) %(upstream:remotename) %(upstream:remoteref)",
      "refs/heads",
    ]);
    const branch = await this.git(path, ["symbolic-ref", "-q", "HEAD"]);
    const row = refs.stdout.split("\n").find((line) => line.startsWith(`${branch.stdout.trim()} `));
    const [, remote, remoteRef] = row?.split(" ") ?? [];
    if (refs.code !== 0 || branch.code !== 0 || !remote || !remoteRef?.startsWith("refs/heads/")) {
      return "Unpushed work or no upstream";
    }
    const url = await this.git(path, ["remote", "get-url", "--", remote]);
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+)$/i.exec(
      url.stdout.trim(),
    );
    const repo = match?.[1]?.replace(/\.git$/i, "");
    if (
      url.code !== 0 ||
      repo?.toLowerCase() !== `${project.github.owner}/${project.github.repo}`.toLowerCase()
    ) {
      return "Unpushed work could not be ruled out for this upstream";
    }
    // Query outside the checkout and disable config so a repo cannot rewrite the URL or supply helpers.
    const base = canonical(this.cwd);
    const remoteResult = await this.git(
      base,
      [
        "-C",
        base,
        "--git-dir",
        join(base, "disk-hygiene-no-repo"),
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        "ls-remote",
        "--exit-code",
        "--refs",
        `https://github.com/${repo}.git`,
        remoteRef,
      ],
      true,
    );
    const [tip, ref] = remoteResult.stdout.trim().split("\t");
    if (remoteResult.code !== 0 || !tip || !/^[a-f0-9]{40,64}$/.test(tip) || ref !== remoteRef) {
      return "Unpushed work or upstream unavailable";
    }
    const covered = await this.git(path, ["merge-base", "--is-ancestor", oid, tip]);
    if (covered.code !== 0) return "Unpushed commits";
    const current = await this.git(path, ["rev-parse", "--verify", "HEAD"]);
    return current.code === 0 && current.stdout.trim() === oid
      ? null
      : "HEAD changed during the scan";
  }

  async remove(project: Project, root: string, path: string): Promise<boolean> {
    if (path === root || !contains(root, path)) return false;
    const result = await this.git(project.path, ["worktree", "remove", "--", path]);
    return result.code === 0;
  }
}
