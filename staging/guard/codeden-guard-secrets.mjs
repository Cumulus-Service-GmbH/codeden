import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const SCRIPT_SECRET_FAMILY = /keyvault|secret|appsettings|connection.string|security|sqlcmd|ERPURE.SQL/i;
export const resolveScriptPath = (cwd, path) => path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);

const JEV_CREDENTIAL_DENIAL = "reading Jev credentials from the fallback file or macOS keychain";
const JEV_FILE = resolve(homedir(), ".config", "trioharness", "jev.env");
const JEV_FILE_TEXT = /(?:^|[^\w.-])(?:\.config\/)?trioharness\/jev\.env(?![\w.-])/i;
const JEV_NATIVE_ACCESS = /\b(?:keyring|getPassword|SecItemCopyMatching|SecKeychainFindGenericPassword)\b/i;
const JEV_ENTRY = /typesafe\.apiKey/i;
const JEV_READER_PATH = resolve(homedir(), ".config", "trioharness", "jev-keyring-runtime", "bin", "jev-keychain-reader");
const realPath = path => {
  try { return realpathSync(path); } catch { return null; }
};
const JEV_READER = /\bjev-keychain-reader\b[\s\S]*?\bread\b/i;
const JEV_SCRIPTS = new Set([
  ".claude/skills/trioharness-codeden/scripts/jev.mjs",
  ".claude/skills/trioharness-lean/scripts/jev.mjs",
  ".codex/skills/trioharness-codeden/scripts/jev.mjs",
].map(path => resolve(homedir(), path)));

function jevCredentialText(text, trustedJev = false) {
  return JEV_FILE_TEXT.test(text.replace(/["'\\]/g, "")) ||
    !trustedJev && (JEV_READER.test(text) || (JEV_NATIVE_ACCESS.test(text) && JEV_ENTRY.test(text))) ? JEV_CREDENTIAL_DENIAL : null;
}

export const programName = (word = "") => word.split(/[\\/]/).at(-1).toLowerCase().replace(/\.(?:cmd|exe|ps1)$/, "");
export const isAzureProgram = word => /^az(?:\.cmd|\.exe)?$/i.test(word.split(/[\\/]/).at(-1));
export function azureProgramIndex(words) {
  if (isAzureProgram(words[0] ?? "")) return 0;
  if (!PYTHON.test(programName(words[0]))) return -1;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const module = pythonModule(word);
    if (module !== null && /^azure\.cli(?:\.__main__)?$/i.test(module || words[i + 1])) return i;
  }
  return -1;
}
export const isAssignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

const SHELL = /^(?:sh|bash|zsh|dash|ksh|fish)$/;
const INTERPRETER = /^(?:python[\w.-]*|node|perl|ruby|php|osascript|pwsh|powershell|deno|bun|tclsh|lua|rscript)$/;
const LAUNCHER = /^(?:nice|timeout|env|command|exec|caffeinate|pipx|sudo|xargs|parallel|nohup|time|stdbuf|builtin|uvx|uv|poetry|npx|npm|pnpm|bunx|bun|doas|arch|flock|script|watch|busybox|mise|direnv|op|bundle|yarn|setsid|unbuffer|chronic|sandbox-exec)$/;
const EFFECT = /\b(?:subprocess|os\.(?:system|exec\w*|posix_spawn\w*)|popen|child_process|spawn(?:Sync)?|exec(?:File|FileSync|Sync)?|shell_exec|proc_open|file_get_contents|Start-Process|Invoke-Expression|iex|fetch|urllib|requests|https?\.(?:request|get)|net\.connect|Invoke-(?:RestMethod|WebRequest)|do shell script)\b|\bsystem\s*\(/i;
const COMPUTE = /\b(?:chr|decode)\s*\(|fromCharCode|fromCodePoint|atob|b64decode|base64|Buffer\.from|bytes\.fromhex|unhexlify|\[char\]|-join|reverse|\bROT\w*\b|codecs|\\(?:x[\da-f]{2}|u(?:[\da-f]{4}|\{[\da-f]+\})|U[\da-f]{8})|(["'])(?:\\.|(?!\1)[^\\])*\1\s*(?:[+&.]\s*)?["']/i;
const JS = /^(?:node|bun|deno)$/;
const POWERSHELL = /^(?:pwsh|powershell)$/;
const PYTHON = /^python[\w.-]*$/;
const DYNAMIC_EFFECT = /\b(?:eval|Function|__import__|getattr|send|public_send|instance_eval|class_eval|module_eval|assert|call_user_func(?:_array)?)\s*\(|(?<!\.)\bcompile\s*\(|\b(?:require|import)\s*\(\s*(?!\s|["'][\w@./:-]+["']\s*\))|\b(?:vm|importlib)\.|\]\s*\(|\[scriptblock\]\s*::\s*Create|&\s*\(|\.Invoke\s*\(/i;
const pythonModule = word => /^-[A-Za-z]*?m([\s\S]*)$/.exec(word)?.[1] ?? null;
const computesEffect = (name, code) => COMPUTE.test(code) &&
  (EFFECT.test(code) || DYNAMIC_EFFECT.test(code) ||
    /^(?:ruby|perl)$/.test(name) && /\b(?:eval|system|exec|public_send|(?:instance|class|module)_eval)\s+\S|\bqx\s*[^\w\s]/.test(code) || !JS.test(name) && code.includes("`"));

const LAUNCHER_VALUE = {
  "sandbox-exec": /^-[fpDn]$/,
  pnpm: /^(?:-C|--dir|--filter|--filter-prod)$/,
  poetry: /^(?:-C|--directory|-P|--project)$/,
  doas: /^-u$/,
  arch: /^(?:-arch|-e|-u)$/,
  flock: /^(?:-w|-E|--timeout|--conflict-exit-code)$/,
  script: /^(?:-t|-T|--log-in|--log-out|--log-io|--log-timing)$/,
  watch: /^(?:-n|--interval)$/,
  npx: /^(?:-p|--package|--node-options|--userconfig)$/,
  npm: /^(?:-p|--package|--node-options|--userconfig)$/,
  uvx: /^(?:--from|--with|--with-editable|--python|-p)$/,
  uv: /^(?:--project|--directory|--with|--python|-p)$/,
  nice: /^(?:-n|--adjustment)$/,
  timeout: /^(?:-s|-k|--signal|--kill-after)$/,
  env: /^(?:-[uCSPa]|--unset|--chdir|--argv0|--split-string)$/,
  caffeinate: /^-[tw]$/,
  sudo: /^(?:-[A-Za-z]*[ughpCrTtD]|--(?:user|group|host|prompt|close-from|chdir))$/,
  xargs: /^(?:-[aEdIJLnPs]|--(?:arg-file|eof|delimiter|replace|max-lines|max-args|max-procs|max-chars))$/,
  stdbuf: /^(?:-[ioe]|--(?:input|output|error))$/,
  exec: /^-a$/,
  time: /^(?:-f|-o|--format|--output)$/,
  pipx: /^(?:--spec|--python|--index-url|--pip-args)$/,
};

const EXEC_SUBCOMMANDS = {
  mise: /^exec$/,
  direnv: /^exec$/,
  op: /^run$/,
  bundle: /^exec$/,
  pnpm: /^(?:exec|dlx)$/,
  npm: /^exec$/,
  bun: /^x$/,
  poetry: /^run$/,
  uv: /^run$/,
  pipx: /^run$/,
};

export const launcherName = program => programName(program).replace(/^g(?=timeout$|nice$|stdbuf$|env$|xargs$)/, "");

export function launcherTarget(program, args) {
  const name = launcherName(program);
  if (!LAUNCHER.test(name)) return -1;
  let i = 0;
  let options = true;
  let uvTool = false;
  let direnvDirectory = name === "direnv";
  let prefix = Object.hasOwn(EXEC_SUBCOMMANDS, name) || /^(?:timeout|flock|script)$/.test(name);
  for (; i < args.length; i++) {
    const value = args[i];
    if (options && value === "--") { options = false; continue; }
    if (options && /^(?:npx|npm)$/.test(name) && !prefix && /^(?:-c|--call)(?:=|$)/.test(value)) return -1;
    if (options && name === "command" && /^-[pVv]*[Vv][pVv]*$/.test(value)) return -1;
    if (options && name === "script" && /^(?:-c|--command)$/.test(value)) return -1;
    if (options && value.startsWith("-") && value !== "-") {
      if (LAUNCHER_VALUE[name]?.test(value)) i++;
      continue;
    }
    if (name === "env" && isAssignment(value)) continue;
    if (prefix) {
      if (name === "uv" && value === "tool" && !uvTool) { uvTool = true; continue; }
      if (EXEC_SUBCOMMANDS[name] && !EXEC_SUBCOMMANDS[name].test(value)) return -1;
      prefix = false;
      continue;
    }
    if (direnvDirectory) { direnvDirectory = false; continue; }
    if (name === "yarn" && value === "exec" && options) { options = false; continue; }
    return i;
  }
  return -1;
}

function inlineOption(name, value) {
  if (name === "fish" && /^--(?:command|init-command)(?:=|$)/.test(value)) {
    return { attached: value.includes("=") ? value.slice(value.indexOf("=") + 1) : undefined };
  }
  if (/^(?:node|bun)$/.test(name) && /^-[A-Za-z]*[ep][A-Za-z]*$/.test(value)) return {};
  if (name === "fish" && value === "-C" || SHELL.test(name) && /^-[A-Za-z]*c[A-Za-z]*$/.test(value)) return {};
  if (POWERSHELL.test(name) && /^-(?:c|co|com|comm|comma|comman|command|cwa|commandwithargs)(?::|$)/i.test(value)) {
    return { attached: value.includes(":") ? value.slice(value.indexOf(":") + 1) : undefined };
  }
  const pattern = PYTHON.test(name) ? /^-[bBdEiIOPqRsSuvx]*c([\s\S]*)$/ :
    name === "perl" ? /^-[anpwlstuTWXC]*[eE]([\s\S]*)$/ :
    name === "php" ? /^-r([\s\S]*)$/ : name === "ruby" ? /^-[anpwl]*e([\s\S]*)$/ : name === "osascript" ? /^-e([\s\S]*)$/ :
    /^(?:node|bun)$/.test(name) ? /^--(?:eval|print)(?==|$)=?([\s\S]*)$/ : null;
  const match = pattern?.exec(value);
  if (match) return { attached: match[1] || undefined };
  if (name === "deno" && value === "eval") return {};
}

function optionsWithValues(name) {
  if (name === "fish") return /^(?:-p|--profile|--profile-startup|--debug|--debug-output|--features)$/;
  if (SHELL.test(name)) return /^(?:[-+][A-Za-z]*[oO][A-Za-z]*|--rcfile|--init-file)$/;
  if (PYTHON.test(name)) return /^(?:-[WXQ]|--check-hash-based-pycs)$/;
  if (/^(?:node|bun)$/.test(name)) return /^(?:-r|-C|--(?:require|import|loader|experimental-loader|conditions|input-type|inspect-port|env-file|max[-_]old[-_]space[-_]size|title|test-reporter|test-reporter-destination|test-name-pattern|test-concurrency))$/;
  if (name === "ruby") return /^-[rCEFKx]$/;
  if (name === "php") return /^-[dczt]$/;
  if (name === "osascript") return /^-[ls]$/;
  if (POWERSHELL.test(name)) return /^-(?:executionpolicy|ep|wd|workingdirectory|outputformat|of|inputformat|if|windowstyle|configurationname|settingsfile)$/i;
  return /^-(?:I|M)$/;
}

export function interpreterScriptIndex(words, includeShell = false) {
  const name = programName(words[0]);
  if (!INTERPRETER.test(name) && !(includeShell && SHELL.test(name))) return -1;
  const valueOptions = optionsWithValues(name);
  for (let i = 1; i < words.length; i++) {
    const value = words[i];
    if (inlineOption(name, value) || PYTHON.test(name) && pythonModule(value) !== null) return -1;
    if (value === "--" || POWERSHELL.test(name) && /^-(?:f|file)$/i.test(value)) {
      return i + 1 < words.length ? i + 1 : -1;
    }
    if (value === "-") return -1;
    if (!value.startsWith("-")) return i;
    if (valueOptions.test(value)) i++;
  }
  return -1;
}

const SHELL_SCRIPT_LIMIT = 256 * 1024;
const SOURCE_SCRIPT_LIMIT = 64 * 1024 * 1024;
const shellOptionValues = value => /^[-+][A-Za-z]+$/.test(value) ? (value.match(/[oO]/g) ?? []).length : 1;
const STDIN_SCRIPT = /^(?:-|\/dev\/(?:stdin|fd\/\d+)|\/proc\/self\/fd\/\d+)$/;
const AWK = /^(?:awk|gawk|mawk|nawk)$/;
function checkAwk(text, inspect) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|\/(?:\\.|[^/\\\n])+\/|#[^\n]*|\|\||\|&?|[A-Za-z_]\w*|\n|[^\s]/g) ?? [];
  const literal = token => token?.startsWith('"') && token.endsWith('"') && token.length >= 2;
  const inspectLiteral = token => {
    if (!literal(token)) return "awk executes unchecked text";
    const escapes = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    const command = token.slice(1, -1).replace(/\\(x[\da-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, escape) =>
      escape.startsWith("x") && escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) :
        /^[0-7]/.test(escape) ? String.fromCharCode(parseInt(escape, 8)) : escapes[escape] ?? escape);
    return inspect(command, true);
  };
  for (const [i, token] of tokens.entries()) {
    let command;
    if (token === "system" && tokens[i + 1] === "(") {
      if (tokens[i + 3] !== ")") return "awk executes unchecked text";
      command = tokens[i + 2];
    } else if (token === "|" || token === "|&") {
      if (tokens[i + 1] === "getline") {
        if (i > 1 && !/^(?:[;{(}\n]|else)$/.test(tokens[i - 2])) return "awk executes unchecked text";
        command = tokens[i - 1];
      } else {
        if (tokens[i + 2] && !/^[;})\n]$/.test(tokens[i + 2]) && !tokens[i + 2].startsWith("#")) {
          return "awk executes unchecked text";
        }
        command = tokens[i + 1];
      }
    } else continue;
    const denial = inspectLiteral(command);
    if (denial) return denial;
  }
  return null;
}

function inspectScript(script, name, inspect, cwd, writtenScripts) {
  const shell = SHELL.test(name) || name === "source" || name === ".";
  const inspectText = (text, fromFile = false) => {
    if (name === null) {
      // Azure policy already checks the caller's argv. Only exempt a pure CLI forwarding shim.
      if (fromFile && isAzureProgram(script) && /^#![ \t]*(?:\/(?:usr\/)?bin\/bash|\/usr\/bin\/env bash)\r?\n[ \t]*(?:exec[ \t]+)?"\/[^"\r\n$`\\]+\/libexec\/bin\/python(?:3(?:\.\d+)?)?"[ \t]+-Im[ \t]+azure\.cli[ \t]+"\$@"[ \t]*(?:\r?\n)?$/.test(text)) return null;
      const header = /^#![^\S\n]*([^\n]+)/.exec(text)?.[1].trim().split(/\s+/) ?? [];
      const interpreter = programName(header[0]) === "env" ?
        header.slice(1).find(word => !word.startsWith("-") && !isAssignment(word)) : header[0];
      if (text.includes("\0")) return null;
      if (POWERSHELL.test(programName(interpreter))) return inspect(text, true, true);
      if (AWK.test(programName(interpreter))) return checkAwk(text, inspect);
      if (SHELL.test(programName(interpreter)) || !interpreter && !/\.(?:py|[cm]?js|ts|rb|pl|php)$/i.test(script)) {
        return inspect(text, true, false, { cwd, scriptContent: true });
      }
    }
    if (shell) return inspect(text, true, false, { cwd, scriptContent: true });
    if (AWK.test(name)) return checkAwk(text, inspect);
    if (POWERSHELL.test(name)) return inspect(text, true, true);
    const trustedJev = fromFile && JEV_SCRIPTS.has(resolveScriptPath(cwd ?? "/", script));
    return inspectSourceContent(text, (command, capturedOutput) => inspect(command, true, false, { capturedOutput }), trustedJev);
  };
  if (STDIN_SCRIPT.test(script)) return "stdin script executes unchecked input";
  if (script === "/dev/null") return null;
  if (cwd === undefined && !(name === null && isAbsolute(script))) {
    const path = resolveScriptPath("/", script);
    const text = writtenScripts?.get(path);
    return text === null ? "written script could not be inspected" : text === undefined ? null : inspectText(text);
  }
  if (!cwd && !isAbsolute(script) && !script.startsWith("~/")) return "script requires a known working directory";
  const path = resolveScriptPath(cwd ?? "/", script);
  const pending = writtenScripts?.get(path);
  if (pending === null) return "written script could not be inspected";
  if (pending !== undefined) {
    const denial = inspectText(pending);
    if (denial) return denial;
  }
  let fd;
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return null;
    if (!stat.isFile()) return "special file script executes unchecked input";
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ENAMETOOLONG", "ELOOP"].includes(error.code)) {
      return null;
    }
    return "script could not be inspected";
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "special file script executes unchecked input";
    if (name === null) {
      const header = Buffer.alloc(256);
      const length = readSync(fd, header, 0, header.length, 0);
      if (header.subarray(0, length).includes(0)) return null;
    }
    if (stat.size > (shell ? SHELL_SCRIPT_LIMIT : SOURCE_SCRIPT_LIMIT)) return "script exceeds inspection limits";
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let size = 0;
    for (let count; size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, size));) size += count;
    if (size !== stat.size) return "script changed during inspection";
    return inspectText(buffer.toString("utf8", 0, size), true);
  } finally {
    closeSync(fd);
  }
}

function checkInline(name, code, inspect, heredoc = false) {
  if (computesEffect(name, code)) {
    return `inline interpreter ${heredoc ? "heredoc" : "code"} computes strings and executes processes or HTTP requests`;
  }
  const alnum = code.replace(/[^a-z0-9]/gi, "");
  return checkSourceContent(code, (command, capturedOutput) => inspect(command, true, false, { capturedOutput })) ??
    (SCRIPT_SECRET_FAMILY.test(alnum) || /getaccesstoken|listkeys|find(?:generic|internet)password|dumpkeychain|exportkeychain/i.test(alnum) ||
      SOURCE_CANDIDATE.test(code) ? inspect(code, false) : null);
}

export function checkExecution(program, args, isPlainWord, inspect, options = {}) {
  const name = launcherName(program.value);
  // With a dynamic cd, inspect only relative paths visible from the hook cwd.
  const scriptCwd = options.cwd === null && !options.scriptContent ? options.hookCwd ?? null : options.cwd;
  const values = args.map(({ value }) => value);
  const targets = [...values, ...(options.redirects ?? []).map(redirect => redirect.target?.value ?? "")];
  const readerPath = realPath(JEV_READER_PATH);
  const isReader = value => value && (programName(value) === "jev-keychain-reader" ||
    (readerPath && realPath(resolveScriptPath(scriptCwd ?? "/", value)) === readerPath));
  if (targets.some(isReader) ||
      (isReader(program.value) && (values.length !== 1 || values[0] !== "present" || !isPlainWord(args[0].syntax)))) {
    return JEV_CREDENTIAL_DENIAL;
  }
  if (targets.some(value => JEV_FILE_TEXT.test(value) ||
      resolveScriptPath(scriptCwd ?? "/", value) === JEV_FILE)) return JEV_CREDENTIAL_DENIAL;
  const evaluator = launcherTarget(name, values);
  const prefix = evaluator < 0 ? values : values.slice(0, evaluator);
  const flags = prefix.slice(0, prefix.indexOf("--") < 0 ? prefix.length : prefix.indexOf("--"));
  if (name === "env" && flags.some(value => /^(?:-[i0v]*S|--split-string)/.test(value))) return "env split-string executes unchecked text";
  if (name === "find") {
    for (let i = 0; i < args.length; i++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(values[i])) continue;
      const end = values.findIndex((value, j) => j > i && (value === ";" || value === "+" && values[j - 1] === "{}"));
      if (end <= i + 1) return "find action requires a literal command and terminator";
      const nested = args.slice(i + 1, end).map(word => word.value.includes("{}")
        ? { ...word, syntax: word.syntax + "{}" } : word);
      const denial = checkExecution(nested[0], nested.slice(1), isPlainWord, inspect,
        { ...options, scriptContent: false, redirects: [] }) ??
        inspect(nested.map(word => word.raw).join(" "), true);
      if (denial) return denial;
      i = end;
    }
  }
  if (AWK.test(name)) {
    let hasProgram = false;
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (/^(?:-F|-v|--field-separator|--assign)$/.test(word.value)) { i++; continue; }
      if (word.value === "--") {
        if (hasProgram || !args[i + 1]) break;
        const code = args[i + 1];
        return isPlainWord(code.syntax) ? checkAwk(code.value, inspect) : "awk requires literal code";
      }
      const inline = /^(?:-e|--source(?:=|$))([\s\S]*)$/.exec(word.value);
      if (inline) {
        const code = inline[1] ? word : args[++i];
        if (!code || !isPlainWord(code.syntax)) return "awk requires literal code";
        const denial = checkAwk(inline[1] || code.value, inspect);
        if (denial) return denial;
        hasProgram = true;
        continue;
      }
      const flag = /^(?:-f|--file(?:=|$))([\s\S]*)$/.exec(word.value);
      if (!flag) {
        if (word.value.startsWith("-")) continue;
        if (!hasProgram) {
          const denial = checkAwk(word.value, inspect);
          if (denial) return denial;
          if (!isPlainWord(word.syntax)) return "awk requires literal code";
        }
        break;
      }
      hasProgram = true;
      const script = flag[1] ? { value: flag[1], syntax: word.syntax } : args[++i];
      if (!script || !isPlainWord(script.syntax)) return "awk requires a literal script path";
      const denial = inspectScript(script.value, name, inspect, scriptCwd, options.writtenScripts);
      if (denial) return denial;
    }
  }
  if (evaluator < 0 && (name === "npx" || name === "npm" && flags.includes("exec"))) {
    let call = -1;
    for (let i = 0; i < flags.length; i++) {
      if (LAUNCHER_VALUE[name].test(flags[i])) { i++; continue; }
      if (/^(?:-c|--call)(?:=|$)/.test(flags[i])) { call = i; break; }
    }
    if (call >= 0) {
      const flag = args[call];
      const code = flag.value.includes("=") ? { ...flag, value: flag.value.slice(flag.value.indexOf("=") + 1) } : args[call + 1];
      return !code || !isPlainWord(code.syntax) ? "launcher requires literal command text" : inspect(code.value, true);
    }
  }
  if (/^(?:script|flock)$/.test(name) && flags.some(value => /^(-c|--command)(?:=|$)/.test(value))) {
    return name + " executes unchecked text";
  }
  if (name === "eval") return "eval executes unchecked shell text";
  if (name === "source" || name === ".") {
    if (!options.scriptContent && args[0] && !isPlainWord(args[0].syntax)) return "source requires a literal script path";
    if (args[0] && isPlainWord(args[0].syntax)) return inspectScript(args[0].value, name, inspect, scriptCwd, options.writtenScripts);
  }
  if ((!options.scriptContent || program.xargs) && !isPlainWord(program.syntax)) return "dynamic command head executes unchecked text";
  if (evaluator >= 0) {
    const xargsInput = name === "xargs" && flags.some(value => /^(?:-a|--arg-file)/.test(value));
    const replacement = name === "xargs" && flags.flatMap((value, i) => {
      if (value === "-i" || value === "--replace") return ["{}"];
      const match = /^(?:-([Ii])(.*)|--replace=(.*))$/.exec(value);
      return match ? [match[2] || match[3] || (match[1] === "I" ? flags[i + 1] : "{}")] : [];
    }).at(-1);
    const nested = args.slice(evaluator).map(word => replacement && word.value.includes(replacement)
      ? { ...word, syntax: word.syntax + "{}" } : word);

    if (name === "watch" && !flags.some(value => /^(?:-x|--exec)$/.test(value))) {
      if (!args.slice(evaluator).every(word => isPlainWord(word.syntax))) return "watch requires literal command text";
      const denial = inspect(values.slice(evaluator).join(" "), true);
      if (denial) return denial;
    }
    let cwd = options.cwd;
    if (name === "env" && cwd) {
      for (let i = 0; i < flags.length; i++) {
        const match = /^(?:--chdir(?:=|$)|-C)(.*)$/.exec(flags[i]);
        if (!match) continue;
        const directory = match[1] || flags[++i];
        if (!directory || !isPlainWord(args[i].syntax)) { cwd = null; break; }
        cwd = resolveScriptPath(cwd, directory);
      }
    }
    return checkExecution({ ...nested[0], piped: program.piped || xargsInput, xargs: program.xargs || name === "xargs" }, nested.slice(1),
      isPlainWord, inspect, { ...options, cwd });
  }
  if (!SHELL.test(name) && !INTERPRETER.test(name)) {
    if (!program.value.includes("/") || !isPlainWord(program.syntax) || scriptCwd === null && !isAbsolute(program.value)) return null;
    return inspectScript(program.value, null, inspect, scriptCwd, options.writtenScripts);
  }
  const redirects = (options.redirects ?? []).filter(({ syntax }) => /^\d*</.test(syntax));
  if (args.some(word => /<\(/.test(word.syntax))) return "redirection into a shell or interpreter executes unchecked input";
  const heredocDenial = interpreterHeredocDenial(name, redirects, options.heredocs, inspect);
  if (heredocDenial) return heredocDenial;
  let source;
  let inlineCode = false;
  let module = false;
  let forceStdin = false;
  let testMode = false;
  let syntaxOnly = false;
  const valueOptions = optionsWithValues(name);
  const inspectOperand = word => {
    if (!word) return null;
    if (!isPlainWord(word.syntax)) return options.scriptContent && !program.xargs ? null : "execution requires a literal script path";
    if (options.scriptContent && options.cwd === null && !isAbsolute(word.value) && !word.value.startsWith("~/")) return null;
    return inspectScript(word.value, name, inspect, scriptCwd, options.writtenScripts);
  };
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const { value } = word;
    if (POWERSHELL.test(name) && /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)(?::|$)/i.test(value)) {
      return "PowerShell encoded commands are denied";
    }
    if (name === "node" && value === "--test") testMode = true;
    if (SHELL.test(name) && /^\+[A-Za-z]*n[A-Za-z]*$/.test(value)) syntaxOnly = false;
    if ((name === "bash" || name === "sh") && value === "-n" || name === "node" && value === "--check") {
      syntaxOnly = true;
      continue;
    }
    if (name === "bun" && /^(?:run|test|build|install|add|remove|update)$/.test(value)) {
      // A named Bun task is not a script path. Explicit file operands still are.
      const task = args[i + 1];
      if (value === "run" && task && /[./]/.test(task.value)) return inspectOperand(task);
      return null;
    }
    if (name === "deno" && /^(?:test|check|fmt|lint|task|bench|info)$/.test(value)) return null;
    if (name === "deno" && value === "run") continue;
    const inline = inlineOption(name, value);
    if (inline) {
      if (name === "deno" || SHELL.test(name) && name !== "fish") {
        if (SHELL.test(name) && valueOptions.test(value)) i += shellOptionValues(value);
        while ((SHELL.test(name) && args[i + 1]?.value === "-") || /^[-+][^-]|^--/.test(args[i + 1]?.value ?? "")) {
          const flag = args[++i].value;
          if (flag === "--" || flag === "-") break;
          if (valueOptions.test(flag)) i += SHELL.test(name) ? shellOptionValues(flag) : 1;
        }
      }
      if (value === "-p" && /^(?:node|bun)$/.test(name) && args[i + 1]?.value === "-e") i++;
      let code = inline.attached === undefined ? args[++i] :
        { value: inline.attached, syntax: word.syntax };
      if (!code && program.xargs) return "pipe into a shell or interpreter executes unchecked input";
      if (!code || !isPlainWord(code.syntax)) return "inline execution requires literal code";
      if (POWERSHELL.test(name) && code.value === "-") { forceStdin = true; break; }
      if (POWERSHELL.test(name)) {
        const tail = args.slice(i + 1);
        if (!tail.every(arg => isPlainWord(arg.syntax))) return "inline execution requires literal code";
        code = { value: [code, ...tail].map(arg => arg.value).join(" ") };
      }
      const denial = SHELL.test(name) ? inspect(code.value, true) :
        checkInline(name, code.value, inspect) ?? (POWERSHELL.test(name) ? inspect(code.value, true, true) : null);
      if (denial) return denial;
      inlineCode = true;
      if (!/^(?:fish|perl|ruby|osascript)$/.test(name)) break;
      continue;
    }
    if ((PYTHON.test(name) || /^(?:node|bun)$/.test(name)) && /^(?:-i|--interactive)$/.test(value) ||
        SHELL.test(name) && /^-[A-Za-z]*s[A-Za-z]*$/.test(value)) {
      forceStdin = true;
      break;
    }
    if (PYTHON.test(name) && pythonModule(value) !== null) {
      const operand = pythonModule(value) ? word : args[i + 1];
      module = !!operand && isPlainWord(operand.syntax);
      if (program.xargs && !module) return "xargs requires a literal module";
      break;
    }
    if (JS.test(name) && /^(?:-r|--(?:require|import|loader|experimental-loader))(?:=|$)|^-r[^-]/.test(value)) {
      const preload = value.includes("=") ? { ...word, value: value.slice(value.indexOf("=") + 1) } :
        /^-r./.test(value) ? { ...word, value: value.slice(2) } : args[++i];
      const denial = inspectOperand(preload);
      if (denial) return denial;
      continue;
    }
    if (valueOptions.test(value)) {
      const count = SHELL.test(name) && name !== "fish" ? shellOptionValues(value) : 1;
      if (SHELL.test(name) && value.startsWith("+") &&
          args.slice(i + 1, i + 1 + count).some(word => word.value === "noexec")) syntaxOnly = false;
      i += count;
      continue;
    }
    if (value === "--" || POWERSHELL.test(name) && /^-(?:f|file)$/i.test(value)) {
      source = args[i + 1];
      break;
    }
    if (value === "-" || !/^[-+]/.test(value)) {
      if (!inlineCode) source = word;
      break;
    }
  }
  if (syntaxOnly) return null;
  const stdinCommand = forceStdin || !inlineCode && !module && !testMode && (!source || STDIN_SCRIPT.test(source.value));
  if ((program.piped || program.xargs) && stdinCommand) return "pipe into a shell or interpreter executes unchecked input";
  if (stdinCommand && redirects.some(({ syntax }) => /^\d*<(?:<<|[^<]|$)/.test(syntax))) {
    return "redirection into a shell or interpreter executes unchecked input";
  }
  if (source && STDIN_SCRIPT.test(source.value) && source.value !== "-") return "stdin script executes unchecked input";
  const informational = args.length === 1 && /^(?:--help|--version|-v|-VV?|-h)$/.test(args[0].value);
  if (options.codex && stdinCommand && !informational && !redirects.length && !options.scriptContent) {
    return "interactive shell or interpreter executes unchecked input";
  }
  return source?.value === "-" ? null : inspectOperand(source);
}

const AZURE_HOST = /^(?:https?:\/\/)?(?:management\.azure\.com|(?:[\w-]+\.)*vault\.azure\.net)(?=[:/?#]|$)/i;
const HTTP_CLIENT = /^(?:curl|wget|http|https|httpie|invoke-restmethod|invoke-webrequest|irm|iwr)$/;
const SECRET_ENDPOINT = /\/secrets(?:[/?#]|$)|listsecrets|\/config\/(?:appsettings|connectionstrings)\/list|list(?:function)?appsettings|publishingcredentials|listkeys/i;

export function checkAzureUrl(program, words, isPlainWord) {
  const names = words.map(({ value }) => value);
  let index = 0;
  for (let offset; (offset = launcherTarget(names[index], names.slice(index + 1))) >= 0;) index += offset + 1;
  const az = azureProgramIndex(names.slice(index));
  const http = HTTP_CLIENT.test(programName(names[index])) ||
    (az >= 0 && names.slice(index + az + 1).includes("rest"));
  for (const { value, syntax } of words) {
    const url = value.replace(/^--[\w-]+=/, "");
    const host = url.match(AZURE_HOST);
    if (!host) continue;
    if ((http || !/^(?:rg|grep|git|echo|printf)$/.test(programName(program.value))) && SECRET_ENDPOINT.test(url.slice(host[0].length))) return "HTTP command against an Azure secret store or config list endpoint";
    if (http && (!isPlainWord(syntax) || /[$`]/.test(syntax))) return "dynamic URL in an Azure HTTP command";
  }
  return null;
}

const HEREDOC_WORD = /^\d*<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\[^\n]|[^\s;&|<>()'"\\])+)/;

function heredocEnd(command, body, indent, delimiter) {
  const end = new RegExp(`^${indent ? "\\t*" : ""}${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?$`, "gm");
  end.lastIndex = body;
  return end.exec(command);
}

// Shells consume queued heredoc bodies in declaration order, including across pipelines.
export function collectHeredocs(command, redirects, spans) {
  const bodies = new Map();
  let body = 0;
  let previousNewline = -1;
  for (const redirect of redirects) {
    if (!/^\d*<<(?!<)/.test(redirect.syntax)) continue;
    if (redirect.start > previousNewline && redirect.start < body) continue;
    const header = HEREDOC_WORD.exec(command.slice(redirect.start));
    const newline = command.indexOf("\n", redirect.start);
    if (!header || newline < 0) break;
    const [, indent, word] = header;
    const delimiter = word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_, single, double, escaped) =>
      single ?? double?.replace(/\\([$`"\\])/g, "$1") ?? escaped);
    body = Math.max(body, newline + 1);
    const end = heredocEnd(command, body, indent, delimiter);
    if (!end) break;
    bodies.set(redirect.start, command.slice(body, end.index));
    const stop = end.index + end[0].length;
    if (stop > body) spans?.push({ start: body, end: stop, contentEnd: end.index, quoted: word !== delimiter, redirectStart: redirect.start });
    previousNewline = newline;
    body = end.index + end[0].length + 1;
  }
  return bodies;
}

function interpreterHeredocDenial(name, redirects, heredocs, inspect) {
  for (const redirect of redirects) {
    if (!/^\d*<<(?!<)/.test(redirect.syntax)) continue;
    const code = heredocs.get(redirect.start + redirect.syntax.indexOf("<<"));
    if (code === undefined) return "interpreter heredoc could not be inspected";
    const denial = SHELL.test(name) ? inspect(code, true) :
      checkInline(name, code, inspect, true) ?? (POWERSHELL.test(name) ? inspect(code, true, true) : null);
    if (denial) return denial;
  }
  return null;
}

const PROCESS_CALL = /\b(?:subprocess\.[\w.]+|os\.(?:system|popen|exec\w*|posix_spawn\w*)|child_process\.exec|(?<!\.)exec|spawn(?:Sync)?|exec(?:File|FileSync|Sync)|fork|popen|system|shell_exec|proc_open)\s*\(|\bStart-Process\s+(?:-FilePath\s+)?/ig;
const SOURCE_CANDIDATE = /\b(?:az|sqlcmd|go-sqlcmd|mssqlclient|osql|isql|tsql|bcp|mssql-cli|sqlpackage|invoke-sqlcmd|security)\b|(?:vault\.azure\.net|management\.azure\.com)/i;
const SOURCE_PROGRAM = /^(?:az|sqlcmd|go-sqlcmd|mssqlclient|osql|isql|tsql|bcp|mssql-cli|sqlpackage|invoke-sqlcmd|security)$/i;
const SOURCE_LITERAL = /^\s*([[(]\s*)?(?:[rfb]{1,2})?(["'`])((?:\\.|(?!\2)[^\\])*)\2/i;
const SOURCE_ARG = /^\s*,\s*(?:(["'])([^"']*)\1|([^,\]\)]+))/;
const SOURCE_HTTP_CALL = /\b(?:fetch|https?\.(?:request|get)|requests\.(?:get|post|request)|urlopen)\s*\(/i;
const SOURCE_URL = /https?:\/\/(?:[\w.-]+\.)?(?:vault\.azure\.net|management\.azure\.com)[^\s"'`),]*/ig;

const AZURE_SOURCE_FAMILY = /keyvault|secret|appsettings|connection.string|get-access-token|publishing|\bkeys\b|\brest\b/i;

function sourceAzureArgv(program, tail, opener) {
  const array = /^\s*,\s*\[/.exec(tail);
  if (!array && !opener) {
    return /^\s*,\s*(?:[A-Za-z_$][\w$]*(?:\s*[.(\[]|\s*[,)]|$)|\$\{)/.test(tail) ? null : program;
  }
  let rest = array ? "," + tail.slice(array[0].length) : tail;
  const literals = [];
  const argv = [];
  let dynamic = false;
  for (let arg; (arg = SOURCE_ARG.exec(rest)); rest = rest.slice(arg[0].length)) {
    if (!arg[1] && !arg[3].trim()) break;
    if (arg[1]) {
      literals.push(arg[2]);
      const value = arg[2];
      argv.push(/^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'");
    } else {
      dynamic = true;
      argv.push('"$ARG"');
    }
  }
  if (array && /^\s*,?\s*\]\s*\./.test(rest)) return program;
  dynamic ||= /^\s*\]\s*\+/.test(rest);
  if (dynamic) {
    const firstDynamic = argv.indexOf('"$ARG"');
    const prefix = argv.slice(0, firstDynamic < 0 ? argv.length : firstDynamic);
    if (prefix.slice(0, 3).join(" ") === "keyvault secret list" && literals.length === prefix.length) {
      return [program, ...prefix].join(" ");
    }
    if (!AZURE_SOURCE_FAMILY.test(literals.join(" "))) {
      // A complete literal prefix can still name a production write.
      return prefix.length >= 2 ? [program, ...prefix].join(" ") : null;
    }
  }
  return [program, ...argv].join(" ");
}

// Recognize literal process arguments and HTTP endpoints. Computed source programs need language-specific analysis.
export function checkSourceContent(text, inspect) {
  return inspectSourceContent(text, inspect, false);
}

function inspectSourceContent(text, inspect, trustedJev) {
  const denial = jevCredentialText(text, trustedJev);
  if (denial) return denial;
  if (!SOURCE_CANDIDATE.test(text)) return null;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const offset = lineStart;
    lineStart += line.length + 1;
    if (SOURCE_CANDIDATE.test(line) && SOURCE_HTTP_CALL.test(line)) {
      for (const { 0: url } of line.matchAll(SOURCE_URL)) {
        const denial = checkAzureUrl({ value: "curl" }, [{ value: url, syntax: "" }], () => true);
        if (denial) return denial;
      }
    }
    for (const call of line.matchAll(PROCESS_CALL)) {
      const operands = line.slice(call.index + call[0].length);
      const match = SOURCE_LITERAL.exec(operands) ??
        (/^\s*(?:[[(]\s*)?$/.test(operands) &&
          SOURCE_LITERAL.exec(text.slice(offset + call.index + call[0].length)));
      if (!match) continue;
      const literal = match[3].trimStart();
      const program = literal.split(/\s/, 1)[0];
      if (!SOURCE_PROGRAM.test(programName(program))) continue;
      let command = literal;
      let tail = operands.slice(match[0].length);
      if (literal === program && isAzureProgram(program)) {
        const fullTail = text.slice(offset + call.index + call[0].length + match[0].length);
        const argv = sourceAzureArgv(program, fullTail, match[1]);
        if (argv) {
          const capturedOutput = /^(?:subprocess\.check_output|execFileSync)\s*\(/i.test(call[0]);
          const denial = inspect(argv, capturedOutput);
          if (denial) return denial;
        }
        continue;
      }
      const separateArgv = /^\s*,\s*\[/.exec(tail);
      if (literal === program && (separateArgv || match[1])) {
        if (separateArgv) tail = "," + tail.slice(separateArgv[0].length);
        for (let arg; (arg = SOURCE_ARG.exec(tail)); tail = tail.slice(arg[0].length)) {
          command += arg[1] ? " '" + arg[2].replace(/'/g, "'\\''") + "'" : ' "$ARG"';
        }
      }
      const denial = inspect(command);
      if (denial) return denial;
    }
  }
  return null;
}
