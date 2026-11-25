import type { ItemOf } from "./items";
import { redactSecrets } from "./redact";

type Tool = Partial<
  Pick<
    ItemOf<"approval_request">,
    | "action"
    | "command"
    | "hookAsk"
    | "hookReason"
    | "paths"
    | "reason"
    | "singleUse"
    | "toolInput"
    | "toolName"
    | "url"
  >
>;

const path = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/?$/;
const privatePath = /(?:^|\/)(?:\.codeden|\.git|keychains?)(?:\/|$)|keychain/i;
const gitReadPrefix = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false"];
const unquote = (word: string) => word.replace(/^['"]|['"]$/g, "");

const sensitive =
  /(?:secret|credential|password|token|keyvault|(?:^|[/.\s'":])(?:env|pem|key|p12|pfx|kdbx)(?:[/.\s'"]|$))/i;
/** Paths blocked even when physically inside a worktree. */
export function isPrivateReadPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return privatePath.test(normalized) || sensitive.test(normalized);
}
const safeTarget = (value: string) => path.test(value) && !isPrivateReadPath(value);
const flags = {
  cat: /^-[benstuv]+$/,
  ls: /^-[aAldh1]+$/,
  rg: /^(?:-[nHilFSiwcl]+|--no-config)$/,
};

/** Only simple shell words and explicitly listed argument forms may be delegated. */
export function plainReadTargets(tool: Tool, standing = false): string[] | undefined {
  const command = tool.command;
  if (
    tool.action !== "command" ||
    (tool.toolName !== "Bash" && (standing || tool.toolName !== "shell")) ||
    !command ||
    tool.url !== undefined ||
    tool.singleUse ||
    tool.hookAsk ||
    tool.hookReason !== undefined ||
    (tool.paths?.length ?? 0) > 0 ||
    tool.reason?.includes("[codeden-card") ||
    tool.reason?.includes("A hook asked for approval") ||
    !/^[\w ./'"@:=,-]+$/.test(command) ||
    (standing && command.includes(",")) ||
    sensitive.test(command) ||
    redactSecrets(command) !== command
  )
    return;

  const input = tool.toolInput;
  if (tool.toolName === "shell" && input === undefined) return;
  if (
    input !== undefined &&
    (!input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      input.command !== command ||
      (input.run_in_background !== undefined && input.run_in_background !== false) ||
      Object.keys(input).some(
        (key) => !["command", "description", "timeout", "run_in_background"].includes(key),
      ))
  )
    return;

  const source = command.trim();
  const matches = [
    ...source.matchAll(/(?:^| +)("[\w ./:@=,-]+"|'[\w ./:@=,-]+'|[\w./:@=,-]+)(?= |$)/g),
  ];
  if (matches.map(([word]) => word).join("") !== source) return;
  const words = matches.map(([, word]) => word ?? "");
  const [name, ...args] = words;
  if (name === "git") {
    if (tool.toolName === "shell") {
      if (!gitReadPrefix.every((flag, index) => args[index] === flag)) return;
      args.splice(0, gitReadPrefix.length);
    }
    const sub = args.shift();
    if (sub === "show") {
      if (tool.toolName === "shell" && !takeDiffGuards(args)) return;
      if (args.length !== 1) return;
      const [ref = "", file, extra] = (args[0] ?? "").split(":");
      return extra === undefined &&
        /^(?:HEAD|[a-f0-9]{4,64})$/.test(ref) &&
        file &&
        safeTarget(file)
        ? [file]
        : undefined;
    }
    if (standing) return;
    if (sub === "log") {
      if (tool.toolName === "shell") {
        const guards = ["--no-show-signature", "--no-notes", "--no-decorate"];
        if (!guards.every((flag, index) => args[index] === flag)) return;
        args.splice(0, guards.length);
      }
      return args.length === 2 &&
        /^-[1-9][0-9]{0,2}$/.test(args[0] ?? "") &&
        args[1] === "--oneline"
        ? []
        : undefined;
    }
    // Comparing committed and staged objects avoids worktree clean filters. A path keeps
    // content from unrelated staged files out of the result.
    if (sub === "diff") {
      if (tool.toolName === "shell" && !takeDiffGuards(args)) return;
      const file = args[2] ?? "";
      return args.length === 3 && args[0] === "--cached" && args[1] === "--" && safeTarget(file)
        ? [file]
        : undefined;
    }
    return;
  }
  if (!standing && (name === "sed" || name === "nl" || name === "head" || name === "tail")) {
    const file = unquote(args.at(-1) ?? "");
    if (!safeTarget(file)) return;
    if ((name === "head" || name === "tail") && args.length === 1) return [file];
    if (name === "nl") return args.length === 2 && args[0] === "-ba" ? [file] : undefined;
    if (args.length !== 3 || args[0] !== "-n") return;
    const option = unquote(args[1] ?? "");
    const valid =
      name === "sed"
        ? /^[1-9][0-9]*(?:,[1-9][0-9]*)?p$/.test(option)
        : /^[1-9][0-9]*$/.test(option);
    return valid ? [file] : undefined;
  }
  if (name !== "cat" && name !== "ls" && name !== "rg") return;
  if (name === "rg" && tool.toolName === "shell" && args[0] !== "--no-config") return;
  const targets: string[] = [];
  let patternSeen = false;
  for (const word of args) {
    if (word.startsWith("-")) {
      if (!flags[name].test(word)) return;
      continue;
    }
    const value = word.replace(/^['"]|['"]$/g, "");
    if (sensitive.test(value)) return;
    if (name === "rg" && !patternSeen) {
      if (value.startsWith("-")) return;
      patternSeen = true;
      continue;
    }
    if (!safeTarget(value) && value !== ".") return;
    targets.push(value);
  }
  if (name !== "ls" && targets.length === 0) return;
  return targets;
}

function takeDiffGuards(args: string[]): boolean {
  if (args[0] !== "--no-ext-diff" || args[1] !== "--no-textconv") return false;
  args.splice(0, 2);
  return true;
}

export function isPlainReadApproval(tool: Tool): boolean {
  return plainReadTargets(tool) !== undefined;
}

/** Why the provider must ask separately for each call. */
export function sessionApprovalBlockReason(item: ItemOf<"approval_request">): string | undefined {
  if (item.options.includes("allow_session") && plainReadTargets(item, true) !== undefined)
    return undefined;
  return "This action requires a separate approval each time.";
}
