// Which worktrees the harness may touch on its own (reuse, stale close, reclaim).
//
// A branch NAME is not ownership: the user can check out `bambooed/run-A` in a tree of their own. A tree is the
// harness's only when some run registered it (any run, finished or not) or it lives under a `.trioharness` root.
// Even then it is left alone while anything inside it moved recently.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState } from './run-state.mjs';

export const IDLE_MS = 2 * 3600 * 1000;
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin';

// Real path of the deepest existing ancestor + the remainder, so a deleted folder still compares equal to git's view.
export const realOr = p => {
  let cur = resolve(p); const rest = [];
  for (;;) {
    try { return [realpathSync(cur), ...rest].reduce((a, b) => join(a, b)); } catch { /* climb */ }
    const up = resolve(cur, '..'); if (up === cur) return resolve(p);
    rest.unshift(cur.slice(up.length).replace(/^[\\/]+/, '')); cur = up;
  }
};
export const normPath = p => { const n = realOr(p).replace(/\\/g, '/').replace(/\/$/, ''); return CASE_FOLD ? n.toLowerCase() : n; };

export const underHarnessRoot = p => /\.trioharness([\\/]|$)/i.test(String(p).replace(/\\/g, '/'));

// Every tree any run of this repository ever registered. `unknown` is set when a state file cannot be read.
export function registeredEver(main) {
  const all = new Set(); const dir = join(main, '.trioharness-direct', 'runs');
  let ids = []; try { ids = readdirSync(dir); } catch { return all; }
  for (const id of ids) { try { const st = readState(main, id); for (const w of st?.worktrees || []) all.add(normPath(w.path)); } catch { all.unknown = true; } }
  return all;
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120000 });

// Newest sign of life in a tree: tracked files, HEAD and its log and the dependency/build folders' own mtimes.
// A build or editor running without run-lock still touches these. Unknown (git failing) counts as "just now".
export function lastActivityMs(wpath) {
  let newest = 0;
  const touch = p => { try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* vanished */ } };
  try {
    for (const f of git(wpath, 'ls-files', '-z').split('\0').filter(Boolean)) touch(join(wpath, f));
    const gd = resolve(wpath, git(wpath, 'rev-parse', '--git-dir').trim());
    touch(join(gd, 'logs', 'HEAD')); touch(join(gd, 'HEAD')); // not the index: read-only git commands (status) rewrite it
    for (const e of readdirSync(wpath, { withFileTypes: true })) if (e.isDirectory() && e.name !== '.git') touch(join(wpath, e.name));
  } catch { return Infinity; }
  return newest;
}

// Quiet for at least activeWithinMs (a timestamp a few ms ahead of the clock is not activity).
export const quietFor = (wpath, { now = Date.now(), activeWithinMs = IDLE_MS } = {}) => Math.max(0, now - lastActivityMs(wpath)) >= activeWithinMs;

// The harness's own: registered by some run, or under a harness root. `ever` comes from registeredEver(main).
export const harnessOwns = (w, ever) => !ever.unknown && (ever.has(normPath(w.path)) || underHarnessRoot(w.path));
