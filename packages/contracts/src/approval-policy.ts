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
const sensitive =
  /(?:secret|credential|password|token|keyvault|(?:^|[/.\s'"])(?:env|pem|key|p12|pfx|kdbx)(?:[/.\s'"]|$))/i;
const flags = {
  cat: /^-[benstuv]+$/,
  ls: /^-[aAldh1]+$/,
  rg: /^(?:-[nHilFSiwcl]+|--no-config)$/,
};

/** Only simple shell words and explicitly listed argument forms may be delegated. */
export function plainReadTargets(tool: Tool): string[] | undefined {
  const command = tool.command;
  if (
    tool.action !== "command" ||
    tool.toolName !== "Bash" ||
    !command ||
    tool.url !== undefined ||
    tool.singleUse ||
    tool.hookAsk ||
    tool.hookReason !== undefined ||
    (tool.paths?.length ?? 0) > 0 ||
    tool.reason?.includes("[codeden-card") ||
    tool.reason?.includes("A hook asked for approval") ||
    !/^[\w ./'"@:=-]+$/.test(command) ||
    sensitive.test(command) ||
    redactSecrets(command) !== command
  )
    return;

  const input = tool.toolInput;
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
    ...source.matchAll(/(?:^| +)("[\w ./:@=-]+"|'[\w ./:@=-]+'|[\w./:@=-]+)(?= |$)/g),
  ];
  if (matches.map(([word]) => word).join("") !== source) return;
  const words = matches.map(([, word]) => word ?? "");
  const [name, ...args] = words;
  if (name === "git") {
    const [sub, ...rest] = args;
    if (sub !== "show" || rest.length !== 1) return;
    const [ref = "", file, extra] = (rest[0] ?? "").split(":");
    return extra === undefined && /^(?:HEAD|[a-f0-9]{4,64})$/.test(ref) && file && path.test(file)
      ? [file]
      : undefined;
  }
  if (name !== "cat" && name !== "ls" && name !== "rg") return;
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
    if (!path.test(value) && value !== ".") return;
    targets.push(value);
  }
  if (name !== "ls" && targets.length === 0) return;
  return targets;
}

export function isPlainReadApproval(tool: Tool): boolean {
  return plainReadTargets(tool) !== undefined;
}

/** Why the provider must ask separately for each call. */
export function sessionApprovalBlockReason(item: ItemOf<"approval_request">): string | undefined {
  if (item.options.includes("allow_session") && isPlainReadApproval(item)) return undefined;
  return "This action requires a separate approval each time.";
}
