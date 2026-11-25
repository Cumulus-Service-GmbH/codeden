// Verify the server's default and its exact local tracking tip; never consult a local remote/HEAD.
import { execFileSync } from 'node:child_process';

const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const defaultGit = (args, options) => execFileSync('git', args, {
  ...options, stdio: ['ignore', 'pipe', 'pipe']
});
const refuse = (code, reason) => { throw Object.assign(new Error(`${code}: ${reason}`), { code }); };

// Git's ref-format restrictions, applied to the branch component of refs/heads/<branch>.
function validBranch(branch) {
  return branch !== '' && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
    && !branch.includes('..') && !branch.includes('@{') && !branch.endsWith('.')
    && branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * Synchronous. Optional git(args, options) returns stdout (string or Buffer) or throws on failure.
 * options supplies cwd, encoding, env and a 120-second timeout without changing process.env.
 * Callers must retain sha for later reads; ref is informational and may move after this check.
 */
export function resolveTrustedDefault({ repo, remote, git = defaultGit } = {}) {
  const input = typeof remote === 'string' ? remote : '';
  const slash = input.indexOf('/');
  const remoteName = slash < 0 ? input : input.slice(0, slash);
  const requestedBranch = slash < 0 ? null : input.slice(slash + 1);
  const options = {
    cwd: repo, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  };
  const read = (args, code, reason) => {
    try {
      const out = git(args, options);
      if (typeof out !== 'string' && !Buffer.isBuffer(out)) throw new Error('invalid Git output');
      return String(out);
    } catch {
      // Do not expose remote URLs, credentials, or subprocess errors in a refusal.
      return refuse(code, reason);
    }
  };
  const remotes = read(['remote'], 'DEFAULT_REMOTE_UNKNOWN', 'cannot list configured remotes').trim().split('\n');
  if (!remoteName || remoteName.startsWith('-') || !remotes.includes(remoteName)) {
    refuse('DEFAULT_REMOTE_UNKNOWN', 'remote name is not configured');
  }

  const raw = read(['ls-remote', '--symref', remoteName, 'HEAD'], 'DEFAULT_UNVERIFIED', 'remote HEAD is unreadable');
  const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
  const symrefs = lines.map(line => /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line)).filter(Boolean);
  const tips = lines.map(line => /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/i.exec(line)).filter(Boolean);
  if (lines.length !== 2 || symrefs.length !== 1 || tips.length !== 1 || !validBranch(symrefs[0][1])) {
    refuse('DEFAULT_UNVERIFIED', 'remote HEAD must advertise exactly one branch and one commit');
  }
  const branch = symrefs[0][1], sha = tips[0][1].toLowerCase();
  if (requestedBranch !== null && requestedBranch !== branch) {
    refuse('REMOTE_NOT_DEFAULT', 'requested branch is not the advertised default');
  }

  const ref = `refs/remotes/${remoteName}/${branch}`;
  const tip = read(['rev-parse', '--verify', `${ref}^{commit}`], 'REMOTE_REF_STALE', 'tracking commit is missing; fetch and retry').trim();
  if (!HEX.test(tip) || tip.toLowerCase() !== sha) {
    refuse('REMOTE_REF_STALE', 'tracking commit differs from the advertised commit; fetch and retry');
  }
  return { remoteName, branch, ref, sha };
}
