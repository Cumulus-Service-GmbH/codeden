import { binName, CD, namedArg, unwrap } from "./command-words";
import { type PathContext, providerPath, resolveAgainst, type SavedLocation } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * Where relative paths resolve as a command line runs (§11.2). `cd`, `Set-Location` and their kin
 * move the location. A `cd` onto a PowerShell drive that isn't the filesystem (`cd HKCU:\Software`,
 * then `cd Foo`) moves relative paths there (`psDrive`) until a `cd` back to a folder.
 *
 * `pushd` and `Push-Location` save the location they leave on a stack, and `popd` and
 * `Pop-Location` go back to the latest one saved (#541). With nothing saved earlier in the command,
 * the shell's own stack is unknown, so the location stays. Named stacks (`-StackName x`) are kept
 * apart. `Set-Location -StackName x` makes another stack the default and `popd +N` drops an entry,
 * so both forget the stack and later pops stay where they are.
 */

const PUSH = new Set(["pushd", "push-location"]);
const POP = new Set(["popd", "pop-location"]);

/** The context after `cmd` when it changes location (`cd dir`, `Set-Location -Path dir`, `popd`). */
export function afterCd<T extends PathContext>(cmd: SimpleCommand, ctx: T): T {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (!CD.has(bin) && !POP.has(bin)) return ctx;
  const { stack, args } = withoutStackName(tokens.slice(1));
  if (POP.has(bin)) {
    if (args.some((a) => /^[+-]\d+$/.test(a))) return { ...ctx, pushed: undefined };
    return popLocation(ctx, stack);
  }
  if (args.includes("-")) return ctx;
  const target = namedArg(args, ["-path", "-literalpath"]) ?? args.find((a) => !a.startsWith("-"));
  if (PUSH.has(bin)) {
    const saved: SavedLocation = { dir: ctx.dir, psDrive: ctx.psDrive, stack };
    // With no location, `Push-Location` saves the current one and stays.
    const moved = target === undefined ? ctx : moveTo(target, ctx);
    return { ...moved, pushed: [...(ctx.pushed ?? []), saved] };
  }
  if (stack !== undefined) return { ...ctx, pushed: undefined };
  return moveTo(target ?? "~", ctx);
}

/** The context with its location moved to `target`: a folder, or an item on a PowerShell drive. */
export function moveTo<T extends PathContext>(target: string, ctx: T): T {
  const provider = providerPath(target, ctx);
  if (provider && provider.path === undefined) return { ...ctx, psDrive: provider.drive };
  const onDisk = { ...ctx, psDrive: undefined };
  return { ...onDisk, dir: resolveAgainst(provider?.path ?? target, onDisk) };
}

/** Back to the latest location saved on `stack` (the default stack when undefined). */
function popLocation<T extends PathContext>(ctx: T, stack: string | undefined): T {
  const pushed = ctx.pushed ?? [];
  for (let k = pushed.length - 1; k >= 0; k -= 1) {
    const saved = pushed[k] as SavedLocation;
    if (saved.stack !== stack) continue;
    const rest = [...pushed.slice(0, k), ...pushed.slice(k + 1)];
    return { ...ctx, dir: saved.dir, psDrive: saved.psDrive, pushed: rest };
  }
  return ctx;
}

/**
 * The stack a `-StackName x` names (also a prefix, `-Stack x`, or bound, `-StackName:x`),
 * lower-cased, and the other words.
 */
function withoutStackName(args: string[]): { stack?: string; args: string[] } {
  const rest: string[] = [];
  let stack: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const param = /^-(s\w*)(?::(.*))?$/is.exec(arg);
    if (param && "stackname".startsWith((param[1] as string).toLowerCase())) {
      i += param[2] === undefined ? 1 : 0;
      stack = (param[2] ?? args[i] ?? "").toLowerCase();
    } else rest.push(arg);
  }
  return { stack, args: rest };
}
