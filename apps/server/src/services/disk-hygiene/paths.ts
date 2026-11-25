import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

export function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function children(path: string): string[] {
  try {
    return readdirSync(path)
      .sort()
      .map((name) => join(path, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const SENSITIVE =
  /^(?:\.git|\.git-credentials|\.codeden|\.kube|\.docker|auth\.json|install-token|\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.azure|\.gnupg|(?:credentials?|secrets?|tokens?|checkpoints?)(?:[.-].*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|.*\.(?:pem|key|p12|pfx|db|sqlite|sqlite3)(?:[-.].*)?)$/i;

/** Walk without following links. Refuse unfamiliar filesystem objects and credential paths. */
export function measure(path: string, anchor: string, allowGitFile = false): number {
  if (path === anchor || !contains(anchor, path) || realpathSync.native(path) !== path) {
    throw new Error("Path escapes its cleanup directory or uses a symbolic link");
  }
  const root = lstatSync(path);
  if (!root.isDirectory()) throw new Error("Candidate is not a directory");
  const pending = [path];
  let bytes = 0;
  while (pending.length) {
    const entry = pending.pop() as string;
    const stat = lstatSync(entry);
    if (allowGitFile && entry === join(path, ".git") && stat.isFile()) continue;
    if (SENSITIVE.test(basename(entry)) || stat.dev !== root.dev) {
      throw new Error("Contains protected files or a mounted directory");
    }
    if (stat.isSymbolicLink()) {
      if (!contains(path, realpathSync.native(entry))) {
        throw new Error("Contains a symbolic link outside the candidate");
      }
    } else if (stat.isDirectory()) {
      for (const child of children(entry)) pending.push(child);
    } else if (stat.isFile()) {
      if (stat.nlink === 1) bytes += stat.blocks === undefined ? stat.size : stat.blocks * 512;
    } else {
      throw new Error("Contains an unsupported filesystem entry");
    }
  }
  return bytes;
}

/** runTool merges overrides into the server environment. Clear inherited tool configuration. */
export function hygieneEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => /^(?:git_|ssh_|npm_config_|pnpm_|corepack_|node_options$)/i.test(key))
      .map((key) => [key, undefined]),
  );
}
