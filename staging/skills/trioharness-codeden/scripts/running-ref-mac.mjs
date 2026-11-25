import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, writeFileSync
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validRunId } from './ids.mjs';
import { gitIn } from './running-ref-targets.mjs';

const keyPath = () => join(userInfo().homedir, '.config', 'trioharness', 'running-ref.key');
const HEX_KEY = /^[0-9a-f]{64}$/i;
export const SIGNATURE_REASON = 'running-ref.json is missing or not signed by running-ref.mjs for this repo and run ID. Run check again with running-ref.mjs check --run <id>';

function checkKeyStat(stat, platform) {
  if (!stat.isFile()) throw new Error('expected a regular file');
  if (platform !== 'win32' && ((stat.mode & 0o077) || typeof process.getuid !== 'function' || stat.uid !== process.getuid())) {
    throw new Error('expected a regular file owned by the current user with no group or other permissions');
  }
}

export function loadRunningRefKey({ keyFile = keyPath(), create = false, platform = process.platform } = {}) {
  try {
    if (create) {
      try { lstatSync(keyFile); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
        try {
          writeFileSync(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
        } catch (writeError) {
          if (writeError.code !== 'EEXIST') throw writeError;
        }
      }
    }
    checkKeyStat(lstatSync(keyFile), platform);
    const fd = openSync(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      checkKeyStat(stat, platform);
      const value = readFileSync(fd, 'utf8');
      if (value.length !== 64 || !HEX_KEY.test(value)) throw new Error('expected 64 hexadecimal characters');
      return Buffer.from(value, 'hex');
    } finally { closeSync(fd); }
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'RUNNING_REF_KEY_MISSING' : 'RUNNING_REF_KEY_INSECURE';
    throw new Error(`${code}: ${keyFile}: ${error.message}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function gitCommonDir(repo) {
  return realpathSync(resolve(repo, gitIn(repo)(['rev-parse', '--git-common-dir']).trimEnd()));
}

function digest(repo, runId, record, key) {
  const scope = { v: 1, repo: realpathSync(repo), gitCommonDir: gitCommonDir(repo), runId, record };
  return createHmac('sha256', key).update(canonical(scope)).digest();
}

const runDir = (repo, runId) => join(repo, '.trioharness-direct', 'runs', runId);
const recordFile = (repo, runId) => join(runDir(repo, runId), 'running-ref.json');

export function readRecord(repo, runId) {
  if (!validRunId(runId)) return null;
  try { return JSON.parse(readFileSync(recordFile(repo, runId), 'utf8')) ?? { unreadable: true }; }
  catch (error) { return error.code === 'ENOENT' ? null : { unreadable: true }; }
}

function verifyRecord(repo, runId, raw, options) {
  const { mac, ...record } = raw;
  if (mac?.v !== 1 || mac.alg !== 'hmac-sha256' || typeof mac.value !== 'string' ||
      mac.value.length !== 64 || !HEX_KEY.test(mac.value)) throw new Error(SIGNATURE_REASON);
  const key = loadRunningRefKey(options);
  if (!timingSafeEqual(Buffer.from(mac.value, 'hex'), digest(repo, runId, record, key))) throw new Error(SIGNATURE_REASON);
  return raw;
}

export function readVerifiedRecord(repo, runId, { keyFile } = {}) {
  const record = readRecord(repo, runId);
  return record === null ? null : verifyRecord(repo, runId, record, { keyFile });
}

export function writeSignedRecord(repo, runId, result, options) {
  if (!validRunId(runId)) throw new Error('RUN_ID_INVALID');
  const key = loadRunningRefKey(options);
  const { mac: previousMac, ...record } = JSON.parse(JSON.stringify(result));
  const value = digest(repo, runId, record, key).toString('hex');
  const signed = { ...record, mac: { v: 1, alg: 'hmac-sha256', value } };
  mkdirSync(runDir(repo, runId), { recursive: true });
  const file = recordFile(repo, runId);
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(signed, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(tmp, file);
  return signed;
}
