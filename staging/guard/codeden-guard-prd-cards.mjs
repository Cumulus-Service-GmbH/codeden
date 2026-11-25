import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, readSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const home = userInfo().homedir;
const configDir = join(home, ".config", "trioharness");
const dbopsDir = join(home, ".trioharness", "db-ops");
const imageDir = join(dbopsDir, "image");
const registry = "crawrnu4mgjcpja";
const release = "dbops:20261121-4937b7a";
const previous = "dbops:20261116-2";
const job = "job-db-ops";
const jobUpdate = tag => `az containerapp job update -n ${job} -g rg-erpure-demo --image ${registry}.azurecr.io/${tag} -o none`;
const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const path = /^(?:~\/|\.?\.?\/)?[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;
const authorize = /^(['"])([A-Za-z0-9:._-]+)\1$/;
const deployPaths = new Set(["~", home].flatMap(base => [".claude", ".codex"].flatMap(tool =>
  ["trioharness-codeden", "trioharness-lean"].map(skill => `${base}/${tool}/skills/${skill}/scripts/deploy.mjs`))));
const hash = value => createHash("sha256").update(value).digest("hex");
const same = (actual, expected) => actual.length === expected.length && expected.every((word, i) => word === actual[i]);
const starts = (actual, expected) => same(actual.slice(0, expected.length), expected);
const expandHome = value => value.startsWith("~/") ? home + value.slice(1) : value;
const dbopsProgram = join(dbopsDir, "dbops");
export const dbopsLanVerbs = new Set(["lan-tunnel", "lan-logs", "tcp", "probe", "provision-ro"]);

export function dbopsQuery(args) {
  const positional = args.filter(arg => arg !== "--allow-user-tables");
  const userTables = args.length !== positional.length;
  const [key, database, sql] = positional;
  if (positional.length !== 3 || args.length !== 3 + Number(userTables) ||
      !name.test(key) || !/^[A-Za-z0-9_]{1,128}$/.test(database) || !sql) return null;
  return { key, database, sql, userTables, catalog: !userTables && /^erpureai(?:_qa)?$/i.test(database) };
}

function hostCard(scope, target, words, rollback = "none") {
  const argv = JSON.stringify(words);
  return { scope, id: scope,
    ledgerCommand: hash(JSON.stringify(scope === "dbops LAN" ? ["dbops", ...words.slice(1)] : words)),
    reason: `erpure LAN/host action needs the owner's approval card: host ${target}; command ${argv}; rollback: ${rollback}` };
}

export function matchAccessCard(words) {
  const [program, verb, first, ...rest] = words;
  if (expandHome(program) === dbopsProgram) {
    if (verb === "query") {
      const query = dbopsQuery(words.slice(2));
      if (!query || query.catalog) return null;
      const { key, database, sql, userTables } = query;
      const digest = hash(sql);
      return { scope: "dbops query", id: "DB read",
        ledgerCommand: `${key} ${database.toLowerCase()} ${digest} ${userTables}`,
        reason: `DB read needs the owner's approval card: key ${key}; database ${database}; SQL sha256 ${digest}; user tables: ${userTables ? "yes" : "no"}; rollback: none (read-only)` };
    }
    if (dbopsLanVerbs.has(verb) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(first ?? "")) {
      const target = verb === "lan-logs" ? "erpure-linux" : verb === "tcp" ? words.slice(2).join(", ") : first;
      return hostCard("dbops LAN", target, words,
        verb === "provision-ro" ? "drop the created read-only login" : "none");
    }
    return null;
  }
  if (program !== "az") return null;
  const ssh = verb === "ssh" && first === "arc";
  const run = verb === "connectedmachine" && first === "run-command";
  if (!ssh && !run) return null;
  const end = rest.indexOf("--");
  const options = end < 0 ? rest : rest.slice(0, end);
  const targets = { name: [], machine: [] };
  for (const [i, arg] of options.entries()) {
    const match = /^(-n|--name|--machine-name)(?:=(.*))?$/.exec(arg);
    if (match) {
      targets[match[1] === "--machine-name" ? "machine" : "name"].push(match[2] ?? options[i + 1]);
      continue;
    }
    const flag = arg.split("=")[0];
    if (/^-n.|^--(?:ids|ip|hostname|resource-type|resource-id)(?:$|=)/.test(flag) ||
        flag.startsWith("--") && ["--name", "--machine-name", "--ids", "--ip", "--hostname", "--resource-type", "--resource-id"]
          .some(full => full.startsWith(flag))) return null;
  }
  if (targets.name.length > 1 || targets.machine.length > 1 || ssh && targets.machine.length) return null;
  const [target] = targets.machine.length ? targets.machine : targets.name;
  if (!/^erpure-linux$/i.test(target ?? "")) return null;
  // This path is also the Azure write classification deferred by the card.
  const operation = run ? rest[0] : null;
  if (run && !/^[a-z][a-z-]*$/.test(operation ?? "")) return null;
  const scope = ssh ? "az ssh arc" : `az connectedmachine run-command ${operation}`;
  if (operation !== "create") return hostCard(scope, target, words);
  const groups = options.flatMap((arg, i) => {
    const flag = /^(?:-g|--resource-group)(?:=(.*))?$/.exec(arg);
    return flag ? [flag[1] ?? options[i + 1]] : [];
  });
  const [group] = groups;
  const [resource] = targets.name;
  if (groups.length !== 1 || !name.test(group ?? "") || !name.test(resource ?? "") || !targets.machine.length) return null;
  const result = hostCard(scope, target, words,
    `az connectedmachine run-command delete -n ${resource} --machine-name ${target} -g ${group} (own card)`);
  result.reason = result.reason.replace("; host ", "; creates a run-command resource; host ");
  return result;
}

function pairs(words, validators) {
  const values = new Map();
  for (let i = 0; i < words.length; i += 2) {
    const [flag, value] = words.slice(i, i + 2);
    if (value === undefined || !Object.hasOwn(validators, flag) || values.has(flag) || !validators[flag].test(value)) return null;
    values.set(flag, value);
  }
  return values.size === Object.keys(validators).length ? values : null;
}

function card(scope, kind, app, identity, words, rollback) {
  const flags = words.filter(word => word.startsWith("-")).join(" ");
  return {
    scope, id: kind,
    reason: `PRD action needs the owner's approval card: ${kind}; app ${app}; ${identity}; flags ${flags}; rollback: ${rollback}`,
  };
}

function deploy(words, cwd, targets) {
  const script = words[1];
  if (!deployPaths.has(script)) return null;
  const stage = words.at(-1) === "--stage-only";
  const args = words.slice(2, stage ? -1 : undefined);
  const rollback = args.includes("--rollback");
  if (rollback && (stage || args.indexOf("--rollback") !== 4)) return null;
  if (rollback) args.splice(4, 1);
  const values = pairs(args, {
    "--repo": path, "--target": name, "--authorize": authorize,
    ...(!rollback && { "--sha": /^[a-fA-F0-9]{40}$/ }),
  });
  if (!values) return null;
  const target = values.get("--target");
  const [app, ...phrase] = authorize.exec(values.get("--authorize"))[2].split(":");
  const config = targets();
  if (!config.prdApps.has(app) || !config.prdDeploy.has(target.toLowerCase())) return null;
  const sha = values.get("--sha");
  // deploy.mjs phrases: <app>:rollback:<rev>, <app>:stage:<sha12>, <app>:<sha12>, <app>:<sha12>:cleanup-<sha256 of the plan>.
  const cleanup = !rollback && !stage && phrase.length === 2 && /^cleanup-[0-9a-f]{64}$/.test(phrase[1]) ? phrase[1] : null;
  if (rollback ? phrase.length !== 2 || phrase[0] !== "rollback" || !name.test(phrase[1]) :
    stage ? phrase.length !== 2 || phrase[0] !== "stage" || phrase[1] !== sha.slice(0, 12) :
    phrase.length !== (cleanup ? 2 : 1) || phrase[0] !== sha.slice(0, 12)) return null;
  // R4: a cleanup card needs a usable recovery: the app's pinned group and subscription.
  const pin = config.prdAppLocations.get(app.toLowerCase());
  if (cleanup && (!pin?.resourceGroup || !pin?.subscription)) return null;
  const restore = `node ${script} --repo ${values.get("--repo")} --target ${target} --rollback --authorize "${app}:rollback:<previous revision>" (own card)` +
    (cleanup ? `; then reactivate each revision this run reports in cleanup.deactivated (none if empty) with az containerapp revision activate -n ${app} -g ${pin.resourceGroup} --subscription ${pin.subscription} --revision <name> -o none (own card each)` : "");
  const identity = rollback ? phrase[1] : sha.toLowerCase() + (cleanup ? ` with revision cleanup ${cleanup}` : "");
  return {
    ...card("deploy.mjs", rollback ? "deploy rollback" : stage ? "deploy stage-only" : "deploy", app, identity, words,
      stage ? `none needed: a stage-only deploy creates a revision that takes no traffic; to remove it, az containerapp revision deactivate -n ${app} -g ${pin?.resourceGroup ?? "<group>"} --subscription ${pin?.subscription ?? "<subscription>"} --revision <staged revision> -o none (own card)` : restore),
    ledgerCommand: hash(JSON.stringify([expandHome(script), resolve(cwd, expandHome(values.get("--repo"))), target.toLowerCase(), app, identity])),
  };
}

export function isDeployDryRun(command) {
  if (/[^\x20-\x7e\t]/.test(command)) return false;
  const [program, script, ...args] = command.trim().split(/[ \t]+/);
  return program === "node" && deployPaths.has(script) && args.pop() === "--dry-run" &&
    !!pairs(args, {
      "--repo": path, "--target": name,
      ...(args.includes("--sha") && { "--sha": /^[a-fA-F0-9]{40}$/ }),
    });
}

function withoutOutputFlags(words) {
  return words.filter((word, i) => !(word === "-o" || word === "--output" || words[i - 1] === "-o" || words[i - 1] === "--output" ||
    /^-o.|^--o/.test(word)));
}

export function withOutputNone(words) {
  const rest = [];
  let output = 0, quiet = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "-o" || word === "--output") {
      if (words[i + 1] !== "none" || output++) return null;
      i++;
    } else if (word === "--only-show-errors") {
      if (quiet++) return null;
    } else if (/^-o./.test(word) || /^--o/.test(word)) {
      return null;
    } else rest.push(word);
  }
  return output === 1 ? { rest, quiet: quiet === 1 } : null;
}

const appFlags = new Map([["-n", "--name"], ["-g", "--resource-group"]]);
// Clear text only for this fixed list; URL values show only their host (a URL path or query can carry a capability).
const publicEnvName = /^(?:PORT|NODE_ENV|LOG_LEVEL|ASPNETCORE_ENVIRONMENT|NODE_OPTIONS)$/;
const urlHost = value => /^https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i.exec(value)?.[1];
const sensitiveEnvText = /@|:\/\/[^/:]+:|key|secret|token|password|sig=/i;

export function matchWebDeployCard(command, targets, { outputNone = true } = {}) {
  if (/[^\x20-\x7e\t]/.test(command)) return null;
  const typed = command.trim().split(/[ \t]+/);
  const stripped = outputNone ? withOutputNone(typed) : { rest: withoutOutputFlags(typed) };
  if (!stripped) return null;
  const words = stripped.rest;
  const updating = starts(words, ["az", "containerapp", "update"]);
  const verb = updating ? null : ["deactivate", "activate"].find(v => starts(words, ["az", "containerapp", "revision", v]));
  if (!updating && !verb) return null;
  const args = words.slice(updating ? 3 : 4);
  if (updating && !args.includes("--set-env-vars")) return null;
  const env = new Map();
  const flags = [];
  for (let i = 0; i < args.length;) {
    const flag = args[i++];
    if (updating && flag === "--set-env-vars") {
      if (env.size) return null;
      while (i < args.length && !args[i].startsWith("-")) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([-A-Za-z0-9_./:@=+%,]*)$/.exec(args[i++]);
        // az reads `@<path>` values from a local file: never let a card copy a file into an env var.
        if (!assignment || /(?:^|=)@/.test(assignment[2]) || /secretref:/i.test(assignment[2]) || env.has(assignment[1])) return null;
        env.set(assignment[1], assignment[2]);
      }
      if (!env.size) return null;
    } else {
      flags.push(appFlags.get(flag) ?? flag, args[i++]);
    }
  }
  const options = pairs(flags, {
    "--name": name, "--resource-group": name,
    ...(updating ? {
      "--subscription": name,
      ...(flags.includes("--container-name") && { "--container-name": name }),
      ...(flags.includes("--revision-suffix") && { "--revision-suffix": /^[a-z0-9-]+$/ }),
    } : { "--subscription": name, "--revision": /^[a-z0-9-]+$/ }),
  });
  if (!options) return null;
  const app = options.get("--name");
  const group = options.get("--resource-group");
  const placement = targets().prdAppLocations.get(app.toLowerCase());
  if (!placement || group !== placement.resourceGroup ||
      (options.has("--subscription") && options.get("--subscription") !== placement.subscription)) return null;
  options.set("--name", app.toLowerCase());
  if (updating) {
    options.set("--subscription", placement.subscription);
    return {
      scope: "az containerapp update", id: "PRD env update",
      details() {
        const summary = [...env].map(([key, value]) =>
          publicEnvName.test(key) && !sensitiveEnvText.test(value) ? `${key}=${value}`
            : urlHost(value) ? `${key} host ${urlHost(value)} sha256:${hash(value)}` : `${key} sha256:${hash(value)}`).join(", ");
        return {
          ledgerCommand: hash(JSON.stringify([[...options].sort(), [...env].sort()])),
          reason: `PRD env update needs the owner's approval card: app ${app}; resource group ${group}; env ${summary}; rollback: re-run with the previous values from the app's current revision (own card)`,
        };
      },
    };
  }
  const revision = options.get("--revision");
  if (options.get("--subscription") !== placement.subscription) return null;
  const deactivating = verb === "deactivate";
  if (outputNone && deactivating && app !== "erpureai-webchat") return null;
  const revisionArgs = `-n ${app} -g ${group} --subscription ${placement.subscription} --revision ${revision}`;
  const trafficCheck = deactivating ? "; traffic check: the approved command reads the revision's traffic weight first and deactivates only at 0-99%, never at 100% or when the read fails" : "";
  return {
    scope: `az containerapp revision ${verb}`, id: `PRD revision ${verb === "activate" ? "activation" : "deactivation"}`,
    ledgerCommand: hash(JSON.stringify([...options].sort())),
    reason: `PRD revision ${verb === "activate" ? "activation" : "deactivation"} needs the owner's approval card: app ${app}; resource group ${group}; revision ${revision}; rollback: az containerapp revision ${verb === "activate" ? "deactivate" : "activate"} ${revisionArgs} -o none (own card)${trafficCheck}`,
    ...(deactivating && {
      command: `w=$(az containerapp revision show ${revisionArgs} --query properties.trafficWeight -o tsv --only-show-errors) && case "$w" in [0-9]|[1-9][0-9]) az containerapp revision deactivate ${revisionArgs} -o none --only-show-errors ;; *) echo "codeden-guard: revision ${revision} not deactivated: traffic weight '$w' is not 0-99" >&2; exit 3 ;; esac`,
    }),
  };
}

function trafficCard(words, targets) {
  const output = withOutputNone(words);
  if (!output) return null;
  const args = output.rest.slice(5);
  const marker = args.indexOf("--revision-weight");
  if (marker < 0) return null;
  const flags = args.slice(0, marker).map((word, index) => index % 2 ? word : appFlags.get(word) ?? word);
  const options = pairs(flags, { "--name": name, "--resource-group": name, "--subscription": name });
  if (!options) return null;
  const app = options.get("--name");
  const group = options.get("--resource-group");
  const subscription = options.get("--subscription");
  const placement = targets().prdAppLocations.get(app);
  if (!placement || group !== placement.resourceGroup || subscription !== placement.subscription) return null;
  const weights = new Map();
  for (const word of args.slice(marker + 1)) {
    const parsed = /^([a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*)=(0|[1-9][0-9]?|100)$/.exec(word);
    if (!parsed || !parsed[1].startsWith(app + "--") || weights.has(parsed[1])) return null;
    weights.set(parsed[1], Number(parsed[2]));
  }
  if ([...weights.values()].reduce((total, weight) => total + weight, 0) !== 100) return null;
  const allocation = [...weights].map(([revision, weight]) => revision + "=" + weight).join(", ");
  return {
    scope: "az containerapp ingress traffic set",
    id: "PRD named revision traffic",
    ledgerCommand: hash(JSON.stringify([app, group, subscription, [...weights].sort()])),
    reason: `PRD traffic needs the owner's approval card: app ${app}; resource group ${group}; subscription ${subscription}; named revision weights ${allocation}. Approve after verifying that the new revision uses the promoted image digest and recording the previous named revision weights. Roll back by restoring those weights with a separate owner card.`,
  };
}

function appUpdate(words, targets, quiet) {
  if (!quiet) return null;
  const marker = words.findIndex((word, i) => i > 2 && ["--container-name", "--revision-suffix"].includes(word));
  const values = pairs(words.slice(3, marker < 0 ? undefined : marker), {
    "--subscription": name, "--resource-group": name, "--name": name,
    "--image": /^crawrnu4mgjcpja\.azurecr\.io(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)+@sha256:[a-fA-F0-9]{64}$/,
  });
  if (!values) return null;
  const extra = marker < 0 ? [] : words.slice(marker);
  const options = pairs(extra, {
    ...(extra.includes("--container-name") && { "--container-name": name }),
    ...(extra.includes("--revision-suffix") && { "--revision-suffix": /^r[a-fA-F0-9]{8}$/ }),
  });
  if (!options) return null;
  const app = values.get("--name");
  const placement = targets().prdAppLocations.get(app);
  if (placement?.subscription !== values.get("--subscription") ||
      placement.resourceGroup !== values.get("--resource-group")) return null;
  const image = values.get("--image");
  return {
    ...card("az containerapp update", "container app update", app, image, words, `re-run deploy.mjs --rollback for ${app}`),
    ledgerCommand: hash(JSON.stringify([...values, ...options].sort())),
  };
}

function dbopsBuild(words, cwd, cd) {
  const directory = cd ? resolve(cwd, expandHome(cd)) : cwd;
  if (directory !== imageDir) return null;
  const args = words.slice(3);
  if (args.some(arg => arg.startsWith("dbops-mig:"))) {
    const context = args.pop();
    if (context !== "." && context !== imageDir && context !== "~/.trioharness/db-ops/image") return null;
    const noLogs = args.indexOf("--no-logs");
    if (noLogs < 0 || args.lastIndexOf("--no-logs") !== noLogs) return null;
    args.splice(noLogs, 1);
    const values = pairs(args, {
      "-r": /^crawrnu4mgjcpja$/, "-t": /^dbops-mig:[a-fA-F0-9]{16}$/,
      ...(args.includes("--platform") && { "--platform": /^linux\/amd64$/ }),
      ...(args.includes("--file") && { "--file": /^Dockerfile$/ }),
    });
    if (!values) return null;
    const tag = values.get("-t");
    return { scope: "az acr build", id: "dbops migration image",
      ledgerCommand: `az acr build -r ${registry} -t ${tag}`,
      details: () => {
        try {
          const fingerprint = createHash("sha256");
          let remaining = 32 * 1024 * 1024;
          function scan(folder, prefix = "") {
            for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
              const filename = join(folder, entry.name);
              const relative = prefix + entry.name;
              if (entry.isDirectory()) scan(filename, relative + "/");
              else {
                const bytes = readRegularFile(filename, remaining);
                remaining -= bytes.length;
                fingerprint.update(JSON.stringify([relative, hash(bytes)]));
              }
            }
          }
          readRegularFile(join(directory, "Dockerfile"), remaining);
          scan(directory);
          return { reason: `DB migration image build needs the owner's approval card: ${tag}; context ${directory}; context sha256 ${fingerprint.digest("hex")}; tag not verified against a migration; approve only together with the matching dbops migrate card; overwrites the tag if it already exists; rollback: none (rebuild the previous context)`,
            ledgerCommand: `az acr build -r ${registry} -t ${tag}` };
        } catch {
          return { denial: "dbops migration image build: context must contain a regular Dockerfile and readable files without symlinks" };
        }
      } };
  }
  const fileAfter = same(args.slice(-2), ["--file", "Dockerfile"]);
  if (fileAfter) args.splice(-2);
  if (args.pop() !== ".") return null;
  const values = pairs(args, {
    "-r": /^crawrnu4mgjcpja$/,
    "-t": /^dbops:20261121-4937b7a$/,
    ...(args.includes("--file") && !fileAfter && { "--file": /^Dockerfile$/ }),
  });
  if (!values) return null;
  return { scope: "az acr build", id: "ACR build",
    denial: `card-gated PRD build refused: the job already uses ${release}; the tag is mutable` };
}

function dbopsMigration(words, cwd, targets) {
  const [program, verb, key, database, input, script, confirm, sha] = words;
  const prd = confirm === "--confirm-prd";
  if (expandHome(program) !== join(dbopsDir, "dbops") || verb !== "migrate" ||
      !name.test(key ?? "") || !name.test(database ?? "") || !["--script", "--bundle"].includes(input) ||
      !path.test(script ?? "") || (prd ? words.length !== 8 || !/^[a-fA-F0-9]{64}$/.test(sha) :
        confirm !== "--confirm-staging" || words.length !== 7)) return null;
  const filename = resolve(cwd, expandHome(script));
  const scope = "dbops migrate";
  const id = "DB migration";
  return { scope, id, details: () => {
    const db = database.toLowerCase();
    const tier = targets().stagingDatabases.has(db) ? "staging" : "PRD";
    if (prd !== (tier === "PRD")) return { denial: `dbops migrate: confirmation flag does not match the ${tier} database ${database}` };
    let digest;
    try {
      digest = hash(readRegularFile(filename, 4 * 1024 * 1024));
    } catch {
      return { denial: "dbops migrate: script or bundle must be a readable regular file without symlinks, at most 4 MB" };
    }
    if (prd && sha !== digest) return { denial: "dbops migrate: --confirm-prd does not match the script or bundle SHA-256" };
    return {
      ledgerCommand: `dbops migrate ${key} ${db} ${input} ${filename}${prd ? " --sha256 " + digest : ""}`,
      reason: `${tier} DB migration needs the owner's approval card: key ${key}; database ${database} (${tier}); script ${filename} sha256 ${digest}; rollback: none automatic (idempotent script required)${prd ? "" : "; staging execution is not bound to the displayed hash"}`,
    };
  } };
}

function dbopsJob(words) {
  const values = pairs(words.slice(4), {
    "-n": /^job-db-ops$/, "-g": /^rg-erpure-demo$/,
    "--image": /^crawrnu4mgjcpja\.azurecr\.io\/dbops(?::(?:20261121-4937b7a|20261116-2)|@sha256:[a-fA-F0-9]{64})$/,
  });
  if (!values) return null;
  const tag = values.get("--image").split("/")[1];
  const ledgerCommand = hash(JSON.stringify(["job update", job, values.get("--image")]));
  if (tag.startsWith("dbops@")) return { ...card("az containerapp job update", "job update or rollback", job,
    values.get("--image"), words, "update to the previous image digest with its own card"), ledgerCommand };
  return { ...card("az containerapp job update", tag === release ? "job update" : "job rollback", job,
    tag + " (tag is mutable; prefer the digest form)", words,
    tag === release ? `b3: ${jobUpdate(previous)} (own card)` : `b2: ${jobUpdate(release)} (own card)`), ledgerCommand };
}

function rulesetCard(words, cwd) {
  if (words.length !== 7 || !/^repos\/Cumulus-Service-GmbH\/dbops\/rulesets\/[0-9]+$/.test(words[4]) ||
      words[5] !== "--input" || !path.test(words[6]) || !words[6].endsWith(".json")) return null;
  const filename = resolve(cwd, expandHome(words[6]));
  return { scope: "ruleset", id: "GitHub ruleset PUT", details: () => readRulesetReason(filename, words) };
}

const protectMainEndpoint = "repos/CumulusService/codeden/rulesets";
const protectMain = {
  name: "protect-main",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  bypass_actors: [],
};

function canonicalJson(value) {
  try {
    return JSON.stringify(value, (_, entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))
        : entry);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // JSON nested too deeply to serialize cannot match the approved ruleset.
    return null;
  }
}

const approvedProtectMainJson = canonicalJson(protectMain);

function protectMainCard(words, cwd) {
  if (words.length !== 7 || words[4] !== protectMainEndpoint ||
      words[5] !== "--input" || !path.test(words[6]) || !words[6].endsWith(".json")) return null;
  const filename = resolve(cwd, expandHome(words[6]));
  return { scope: "ruleset", id: "GitHub ruleset POST", details: () => readRulesetReason(filename, words) };
}

const protectionEndpoint = /^repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/branches\/([A-Za-z0-9_.-]+)\/protection(?:\/(required_status_checks(?:\/contexts)?|enforce_admins|required_pull_request_reviews|required_signatures|restrictions(?:\/(?:apps|teams|users))?))?$/;

function branchProtectionCard(words, cwd) {
  const [, , , verb, endpoint, input, file] = words;
  const match = protectionEndpoint.exec(endpoint);
  if (!match) return null;
  const [, owner, repo, branch] = match;
  if ([owner, repo, branch].some(segment => segment === "." || segment === "..")) return null;
  if (verb === "DELETE" ? words.length !== 5 :
      words.length !== 7 || input !== "--input" || !path.test(file) || !file.endsWith(".json")) return null;

  const scope = "branch-protection";
  const id = `GitHub branch protection ${verb}`;
  return { scope, id, details: () => {
    try {
      let digest = "none";
      let command;
      if (verb !== "DELETE") {
        const data = readRegularFile(resolve(cwd, expandHome(file)), 64 * 1024, true);
        const body = data.toString("utf8");
        if (!Buffer.from(body).equals(data)) throw new Error("invalid UTF-8");
        const json = JSON.parse(body);
        if (!json || typeof json !== "object") throw new Error("invalid branch protection JSON");
        digest = hash(data);
        command = `printf '%s' '${body.replaceAll("'", "'\\''")}' | ${words.slice(0, 6).join(" ")} -`;
      }
      const identity = verb === "DELETE" ? "body none" : `sha256:${digest}`;
      return {
        ...card(scope, id, `${owner}/${repo}`, `branch ${branch}; endpoint ${endpoint}; ${identity}`, words,
          "restore the saved original protection with the same gh api call (own card)"),
        command,
        ledgerCommand: `gh api ${verb} ${endpoint} sha256:${digest}`,
      };
    } catch (error) {
      return { denial: inputFileDenial("branch protection", error) };
    }
  } };
}

function assertNoSymlinks(filename) {
  for (let part = resolve(filename); part !== sep; part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error("symlinked path");
  }
}

class UnsafeCardFile extends Error {}

function inputFileDenial(kind, error) {
  const detail = error instanceof UnsafeCardFile ? error.message : "invalid JSON input";
  return `card-gated PRD action: ${kind} refused: ${detail}`;
}

function readRegularFile(filename, maxBytes, cardInput = false) {
  if (cardInput && /(?:^|[./_-])(?:token|tokens|credentials?|auth|remote-access)(?:[./_-]|$)|(?:^|\/)(?:hosts\.yml|runner\.json|\.netrc|\.npmrc|\.env)(?:[./]|$)/i.test(filename)) {
    throw new UnsafeCardFile("credential files cannot be used as card input");
  }
  assertNoSymlinks(filename);
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (cardInput && stat.nlink !== 1) throw new UnsafeCardFile("hard-linked files cannot be used as card input");
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("invalid file");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size) throw new Error("file size changed during read");
    return bytes.subarray(0, length);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readRulesetReason(filename, words) {
  try {
    const data = readRegularFile(filename, 64 * 1024, true);
    const body = data.toString("utf8");
    if (!Buffer.from(body).equals(data)) throw new Error("invalid UTF-8");
    const ruleset = JSON.parse(body);
    // Pass the approved bytes directly. The execution no longer reopens the input path.
    const command = `printf '%s' '${body.replaceAll("'", "'\\''")}' | ${words.slice(0, 6).join(" ")} -`;
    if (words[3] === "POST") {
      if (canonicalJson(ruleset) !== approvedProtectMainJson) {
        return { denial: "card-gated PRD action: ruleset body is not the approved protect-main ruleset" };
      }
      return {
        ...card("ruleset", "GitHub ruleset POST", "CumulusService/codeden", `sha256:${hash(data)}`, words,
          "delete the created ruleset via gh api -X DELETE repos/CumulusService/codeden/rulesets/<id> (not card-gated today; needs its own guard change and card)"),
        command,
        ledgerCommand: `gh api POST ${protectMainEndpoint}`,
      };
    }
    if (!ruleset || typeof ruleset !== "object" || Array.isArray(ruleset)) throw new Error("invalid ruleset");
    const label = (value, allowed) => allowed.includes(value) ? value : "unspecified";
    const count = value => Array.isArray(value) ? value.length : 0;
    const refs = ruleset.conditions?.ref_name;
    const summary = `enforcement ${label(ruleset.enforcement, ["active", "disabled", "evaluate"])}, ` +
      `target ${label(ruleset.target, ["branch", "tag", "push"])}, ` +
      `rules ${count(ruleset.rules)}, bypass_actors ${count(ruleset.bypass_actors)}; refs include ${JSON.stringify(refs?.include ?? [])}, exclude ${JSON.stringify(refs?.exclude ?? [])}`;
    return {
      ...card("ruleset", "GitHub ruleset PUT", "dbops", `${summary}; sha256:${hash(data)}`, words,
        "restore with the saved original ruleset JSON via the same gh api PUT (own card)"),
      command,
      ledgerCommand: `gh api PUT ${words[4]}`,
    };
  } catch (error) {
    return { denial: inputFileDenial("ruleset", error) };
  }
}

const repoIssuesEndpoint = "repos/CumulusService/codeden";
const repoIssuesWords = ["gh", "api", "-X", "PATCH", repoIssuesEndpoint, "-F", "has_issues=true"];

function actionsCleanupCard(command, cwd) {
  const [body, directive, ...extra] = command.split(/[ \t]+#[ \t]+/);
  if (!body.startsWith("gh api ") || extra.length) return null;
  const pin = directive && /^codeden-list[ \t]+([^\s]+)[ \t]+([a-f0-9]{64})$/.exec(directive.trim());
  if (directive !== undefined && (!pin || !path.test(pin[1]))) return null;

  const requests = body.trim().split(/[ \t]+&&[ \t]+/);
  const selected = new Set();
  let repo;
  for (const request of requests) {
    const parsed = /^gh[ \t]+api[ \t]+-X[ \t]+DELETE[ \t]+repos\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)\/actions\/(?:artifacts\/([1-9][0-9]{0,19})|runs\/([1-9][0-9]{0,19})\/logs)$/.exec(request);
    if (!parsed || (repo && repo !== parsed[1])) return null;
    repo = parsed[1];
    selected.add(parsed[2] ? "artifact\t" + parsed[2] : "run-log\t" + parsed[3]);
  }
  if (selected.size !== requests.length) return null;

  const scope = "actions-cleanup";
  const id = "GitHub Actions cleanup";
  return { scope, id, details() {
    let listBinding = "";
    if (pin) {
      const filename = resolve(cwd, expandHome(pin[1]));
      try {
        const data = readRegularFile(filename, 64 * 1024, true);
        if (hash(data) !== pin[2]) return { denial: "GitHub Actions cleanup: approved ID list hash mismatch" };
        const entries = data.toString("utf8").trimEnd().split(/\r?\n/);
        const allowed = new Set(entries);
        if (entries.some(entry => !/^(?:artifact|run-log)\t[1-9][0-9]{0,19}$/.test(entry)) || allowed.size !== entries.length) {
          return { denial: "GitHub Actions cleanup: invalid approved ID list" };
        }
        if ([...selected].some(entry => !allowed.has(entry))) {
          return { denial: "GitHub Actions cleanup: requested ID is outside the approved list" };
        }
        listBinding = `; list ${filename}; sha256:${pin[2]}`;
      } catch {
        return { denial: "GitHub Actions cleanup: cannot safely read the approved ID list" };
      }
    }
    const entries = [...selected].sort();
    return {
      command: requests.join(" && "),
      reason: `GitHub Actions cleanup needs the owner's approval card: repo ${repo}; ${entries.map(entry => entry.replace("\t", " ")).join(", ")}${listBinding}; deletion is permanent`,
      ledgerCommand: hash(JSON.stringify([repo.toLowerCase(), entries])),
    };
  } };
}

function repoIssuesCard(words) {
  if (!starts(words, ["gh", "api"]) || words.some(word => !/^[A-Za-z0-9_./:@=-]+$/.test(word))) return null;
  if (!words.includes(repoIssuesEndpoint)) return null;
  const scope = "repo-settings";
  const id = "GitHub repo has_issues PATCH";
  if (same(words, repoIssuesWords)) {
    return {
      ...card(scope, id, "CumulusService/codeden", "has_issues true", words,
        [...repoIssuesWords.slice(0, -1), "has_issues=false"].join(" ") + " (manual owner action outside the guard)"),
      ledgerCommand: repoIssuesWords.join(" "),
    };
  }
  const method = words.indexOf("--method");
  const short = words.indexOf("-X");
  const longPatch = method >= 0 && words[method + 1] === "PATCH" || words.includes("--method=PATCH");
  const setting = words.find(word => /^(?:(?:--field|--raw-field|-F|-f)=?)?has_issues=/.test(word));
  if (!setting || !(longPatch || short >= 0 && words[short + 1] === "PATCH")) return null;
  let hint = "the card form is exactly: " + repoIssuesWords.join(" ");
  if (!/^(?:(?:--field|--raw-field|-F|-f)=?)?has_issues=true$/.test(setting)) hint = "only has_issues=true has a card";
  else if (longPatch) hint = "use -X PATCH";
  else if (words.some(word => /^(?:-f|--field|--raw-field)(?:=|$)/.test(word))) hint = "use -F has_issues=true (typed boolean)";
  return { scope, id, denial: "card-gated PRD action: " + hint };
}

function azOutputCorrection(words) {
  const flag = words.findIndex(word => word === "-o" || word === "--output");
  if (flag < 0) return { words: [...words, "-o", "none"], hint: "add -o none (the card form needs -o none)" };
  const value = words[flag + 1];
  if (!value || value.startsWith("-") || value === "none") return null;
  const corrected = [...words];
  corrected[flag + 1] = "none";
  return { words: corrected, hint: "use -o none instead of -o " + value };
}

const mobileApp = /^mobile-api-(?:test|prod)$/;
const mobileGroup = "rg-erpure-mobile";
const mobileSubscription = "537f1b8d-655c-4e06-87dd-c6c88eac894e";
const mobileStorageAccount = `/subscriptions/${mobileSubscription}/resourceGroups/rg-erpure-reportattachments-prd/providers/Microsoft.Storage/storageAccounts/erpurereportattachprd`;
const mobileArmContainers = new Set([
  "mobile-prd-content", "mobile-prd-manifests", "mobile-prd-coordination", "mobile-prd-evidence",
]);
const mobileArmCreateScope = "az storage container-rm create";
const publisherRegistry = `/subscriptions/${mobileSubscription}/resourceGroups/${mobileGroup}/providers/Microsoft.ContainerRegistry/registries/crerpuremobiletest`;
const publisherImage = "crerpuremobiletest.azurecr.io/mobile-api@sha256:c831404c55b6954d1236dffd0d1b9e5b33398854284373296844c37876528e9c";
const publisherReader = { role: "Reader", scope: publisherRegistry };
const verifierPrincipalId = "d63529e0-761c-441b-8c71-a01560b42d99";
const evidencePinPrefix = "az keyvault secret set --vault-name kv-erpure-mobile-test -n report-attachment-evidence-pin-prod --value '{}' --content-type application/json --tags purpose=bootstrap --expires ";
const mobileIssuerPath = "scripts/mobile-release/issue-migration-authority.mjs";
const mobileIssuerSha = "8e34829bb1a19231638d2ccf17ca999e9dfd48ed4eb923945a19ff8566b4a9a8";
const mobileIssuerSource = "tcp:149.97.246.130,59917";
const mobileIssuerScope = "mobile migration authority issuance";
const mobileIssuerLockDigests = {
  "run-lock.mjs": "c70392231721dc1ccde51324bb111f25e78a89ff84bd5f9437f7ffaf8d3e3aab",
  "secret-patterns.mjs": "bea4adf8a824527958f8c5d88d2109277a13519ee7f691652fd37fb732ea02a9",
  "is-main.mjs": "6fd02e249b0c3aff8ebbed04308b7775f4d675a3588856a1639d493dfd57a5c0",
};
const issuerArtifact = /^\/(?:private\/)?tmp\/deploy-x4\/a0-refresh\.[A-Za-z0-9_-]+\/(?:TEST|PROD)-(?:evidence|receipt)\.json$/;
const authorityName = "provision-authority-mount.mjs";
const authoritySha = "34da5471ebd9561d701e29a9e7aa20916689d52ee55b662a5c260c8c70182d7c";
const authorityScripts = new Set(["codeden", "lean"].map(skill =>
  join(home, ".claude", "skills", "trioharness-" + skill, "scripts", authorityName)));
const authorityMounts = {
  "mobile-api-test": { generation: "g2", vaultItem: "mobile-test-migration-authority", active: ["parity-1121", "r49028f74"] },
  "mobile-api-prod": { generation: "g1", vaultItem: "migration-authority-prod", active: ["rdee469c2", "r2a2d6e69"] },
};
const mountVolume = "migration-authority";
const mountPath = "/app/migration-authority";
const mountFile = "applied-set.json";
const mountSession = /^[A-Za-z0-9_-]{1,128}$/;
const cardNonce = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const secretReference = /^([a-z0-9-]+)=keyvaultref:(https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+),identityref:(\/subscriptions\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\/resourceGroups\/[a-zA-Z0-9._-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[a-zA-Z0-9_-]+)$/;
const objectId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sameGrant = (pin, role, scope) =>
  pin.role === role && typeof pin.scope === "string" && pin.scope.toLowerCase() === scope.toLowerCase();

function mobileCard(scope, argv, summary) {
  return {
    scope, id: scope,
    ledgerCommand: hash(JSON.stringify(argv)),
    reason: `${scope} needs the owner's approval card. ${summary}.`,
  };
}

export function parseAuthorityMount(args) {
  const app = args[1];
  if (!Object.hasOwn(authorityMounts, app)) return null;
  const { generation, vaultItem, active } = authorityMounts[app];
  const alias = `migration-authority-${generation}`;
  const version = args[13];
  if (!same(args, ["--app", app, "--rg", mobileGroup, "--volume", mountVolume, "--secret-ref", alias,
       "--path", mountFile, "--mount", mountPath, "--secret-version", version]) || !/^[a-f0-9]{32}$/.test(version ?? "")) return null;
  const secretUri = `https://kv-erpure-mobile-test.vault.azure.net/secrets/${vaultItem}/${version}`;
  const armBase = `/subscriptions/${mobileSubscription}/resourceGroups/${mobileGroup}/providers`;
  return {
    app, alias, secretUri, volume: mountVolume, mountPath, file: mountFile, subscription: mobileSubscription,
    resourceId: `${armBase}/Microsoft.App/containerApps/${app}`,
    identity: `${armBase}/Microsoft.ManagedIdentity/userAssignedIdentities/id-erpure-${app}`,
    suffix: `authority-${generation}`, active: active.map(suffix => `${app}--${suffix}`),
  };
}

function authorityLedgerCommand(args) {
  return hash(JSON.stringify([...args, authoritySha]));
}

export function consumeAuthorityMountCard(args, sessionId, claim) {
  if (!parseAuthorityMount(args) || !mountSession.test(sessionId ?? "") || !cardNonce.test(claim ?? "")) return false;
  return !reservePrdCard(authorityLedgerCommand(args), sessionId, authorityName, { claim, consume: true });
}

function matchMobileArmCreate(words, targets) {
  const container = words[7];
  if (!mobileArmContainers.has(container) || !same(words, [
    ...mobileArmCreateScope.split(" "), "--storage-account", mobileStorageAccount,
    "--name", container, "--public-access", "off",
  ]) || !targets().allowedCreates?.includes(words.join(" "))) return null;
  return mobileCard(mobileArmCreateScope, words,
    `Security rule 14 creates private container ${container} in ${mobileStorageAccount}`);
}

function mobileEvidenceExpiry(value) {
  const utc = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!utc) return null;
  const canonical = `${utc[1]}.${(utc[2] ?? "").padEnd(3, "0")}Z`;
  const expires = Date.parse(canonical);
  const now = Date.now();
  if (!Number.isFinite(expires) || expires < now || expires > now + 60_000 ||
      new Date(expires).toISOString() !== canonical) return null;
  return canonical;
}

function pinModuleAtLoad(script, digest, imports) {
  const url = pathToFileURL(script).href;
  const pins = [[url, digest], ...(imports ?? []).map(([file, sha]) => [pathToFileURL(file).href, sha])];
  const loader = `import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
const pins = new Map(${JSON.stringify(pins)});
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (!context.parentURL && resolved.url !== ${JSON.stringify(url)}) throw Error('Wrong approved script path');
    if (${Boolean(imports)} && !pins.has(resolved.url) && !resolved.url.startsWith('node:')) throw Error('Unapproved script import');
    return resolved;
  },
  load(url, context, next) {
    const result = next(url, context);
    const expected = pins.get(url);
    if (expected && (result.format !== 'module' || createHash('sha256').update(result.source).digest('hex') !== expected)) {
      throw Error('Script SHA-256 changed after approval');
    }
    return result;
  }
});`;
  return "data:text/javascript;base64," + Buffer.from(loader).toString("base64");
}

function matchMobileIssuer(words, cwd) {
  if (words[0] !== "cd" || words[1] !== cwd || words[2] !== "&&" || !/^[A-Za-z0-9_./-]+$/.test(cwd)) return null;
  const project = resolve(process.env.CODEDEN_HOME || join(home, ".codeden"), "wt", "webchatmobile");
  if (dirname(cwd) !== project || !name.test(relative(project, cwd))) return null;
  const evidenceApproval = /^MOBILE_APPROVED_EVIDENCE_SHA256=([a-f0-9]{64})$/.exec(words[3]);
  const actionApproval = /^MOBILE_APPROVED_A0_SHA256=([a-f0-9]{64})$/.exec(words[4]);
  const lockDir = join(home, ".claude/skills/trioharness-lean/scripts");
  const lockPath = join(lockDir, "run-lock.mjs");
  const script = join(cwd, mobileIssuerPath);
  if (!evidenceApproval || !actionApproval || !same(words.slice(5, 13), [
    "node", lockPath, "run", "--name", words[9], "--", "node", script,
  ])) return null;

  const args = words.slice(13);
  const firstVersion = args.at(-1) === "--first-version";
  const flags = pairs(firstVersion ? args.slice(0, -1) : args, {
    "--env": /^(?:TEST|PROD)$/,
    "--sha": /^[a-f0-9]{40}$/,
    "--evidence": issuerArtifact,
    "--data-source": /^tcp:149\.97\.246\.130,59917$/,
    "--initial-catalog": /^ERPureAI$/,
    "--attestation-ref": /^codeden-[A-Za-z0-9_-]+:(?:test|prod)-a0-attest:\d{8}$/,
    "--authorize": /^a0:(?:TEST|PROD):[a-f0-9]{12}:[a-f0-9]{12}$/,
    "--generation": /^[12]$/,
    "--ttl-hours": /^24$/,
    "--receipt": issuerArtifact,
  });
  if (!flags) return null;
  const environment = flags.get("--env");
  const lower = environment.toLowerCase();
  const evidence = flags.get("--evidence");
  const receipt = flags.get("--receipt");
  const candidate = flags.get("--sha");
  if (firstVersion !== (environment === "PROD") || flags.get("--generation") !== (firstVersion ? "1" : "2") ||
      words[9] !== `a0-migration-authority-${lower}` || !flags.get("--attestation-ref").includes(`:${lower}-a0-attest:`) ||
      !flags.get("--authorize").startsWith(`a0:${environment}:${candidate.slice(0, 12)}:`) ||
      !evidence.endsWith(`/${environment}-evidence.json`) || receipt !== join(dirname(evidence), `${environment}-receipt.json`)) return null;
  const pins = Object.entries(mobileIssuerLockDigests).map(([file, digest]) => [join(lockDir, file), digest]);
  try {
    if ([[script, mobileIssuerSha], ...pins].some(([file, digest]) => hash(readRegularFile(file, 64 * 1024)) !== digest)) return null;
  } catch { return null; }

  const result = mobileCard(mobileIssuerScope, [cwd, mobileIssuerSha, pins, evidenceApproval[1], actionApproval[1], [...flags].sort()],
    `Environment ${environment}, candidate ${candidate}, issuer ${script}, issuer sha256 ${mobileIssuerSha}, evidence sha256 ${evidenceApproval[1]}, action sha256 ${actionApproval[1]}`);
  return {
    ...result,
    sqlIdentity: mobileIssuerSource,
    command: [...words.slice(0, 6), "--import", `'${pinModuleAtLoad(lockPath, mobileIssuerLockDigests["run-lock.mjs"], pins.slice(1))}'`,
      ...words.slice(6, 12), "--import", `'${pinModuleAtLoad(script, mobileIssuerSha, [])}'`, ...words.slice(12)].join(" "),
  };
}

function matchMobileCard(command, targets) {
  if (/^[\x20-\x7e\t]+$/.test(command)) {
    const create = matchMobileArmCreate(command.trim().split(/[ \t]+/), targets);
    if (create) return create;
  }
  if (!/^(?:node \/[^\s]*\/provision-authority-mount\.mjs |az (?:containerapp (?:secret set|job create)|keyvault secret set|role assignment create|identity create) )/.test(command)) return null;
  if (/[^\x20-\x7e\t]/.test(command)) return null;
  const typed = command.match(/(?:"[^"]*"|'[^']*'|[^ \t"'])+|["']/g) ?? [];
  if (typed[0] === "node") {
    const [, script, ...args] = typed;
    const mount = parseAuthorityMount(args);
    if (!authorityScripts.has(script) || !mount) return null;
    try {
      if (hash(readRegularFile(script, 64 * 1024)) === authoritySha) {
        const card = mobileCard(authorityName, args,
          `Deploy ${mount.app}--${mount.suffix} at zero traffic in ${mobileGroup}. Secret reference ${mount.alias} at ${mount.secretUri}, mount ${mountPath}, script sha256 ${authoritySha}`);
        return { ...card, details(sessionId) {
          if (!mountSession.test(sessionId ?? "")) return { denial: "deploy card requires a valid session ID" };
          const claim = randomUUID();
          return { ...card, ledgerCommand: authorityLedgerCommand(args), claim,
            command: ["node", "--import", `'${pinModuleAtLoad(script, authoritySha)}'`, ...typed.slice(1),
              "--card-session", sessionId, "--card-claim", claim].join(" ") };
        } };
      }
    } catch { /* Missing or unreadable helper. */ }
    return null;
  }

  const output = withOutputNone(typed);
  if (!output) return null;
  const tokens = output.rest;
  const { allowedCreates = [], grantPrincipals = [], evidencePublisherGrants = [], evidencePublisherPrincipalId, mobileAppLocations } = targets();
  if (starts(tokens, ["az", "containerapp", "secret", "set"])) {
    const [, , , , , app] = tokens;
    const pin = mobileAppLocations?.get(app);
    if (!mobileApp.test(app) || pin?.resourceGroup !== mobileGroup || pin.subscription !== mobileSubscription ||
        !starts(tokens.slice(4), ["-n", app, "-g", mobileGroup, "--secrets"])) return null;
    if (tokens.at(-1) !== "2>/dev/null") return null;
    const pairs = tokens.slice(9, -1).map(token => secretReference.exec(token));
    if (!pairs.length || pairs.some(pair => !pair) || new Set(pairs.map(pair => pair[1])).size !== pairs.length) return null;
    return mobileCard("az containerapp secret set", [app, mobileGroup, ...pairs.map(pair => pair[0].toLowerCase()).sort()],
      `App ${app}, resource group ${mobileGroup}, references ${pairs.map(([, alias, uri, identity]) => `${alias} at ${uri} using identity ${identity}`).join(", ")}`);
  }

  const withoutOutput = tokens.join(" ");
  const role = /^az role assignment create --assignee-object-id ([0-9a-f-]+) --assignee-principal-type ServicePrincipal --role (["'])([a-zA-Z0-9 ]+)\2 --scope (\/[A-Za-z0-9._/-]+)$/.exec(withoutOutput);
  if (role) {
    const [, principalId, , roleName, scope] = role;
    if (!objectId.test(principalId) || scope.endsWith("/") ||
        !grantPrincipals.some(pin => pin.principalId === principalId && sameGrant(pin, roleName, scope))) return null;
    const publisherTuple = sameGrant(publisherReader, roleName, scope) ||
      evidencePublisherGrants.some(pin => sameGrant(pin, roleName, scope));
    const prodApp = `/subscriptions/${mobileSubscription}/resourceGroups/${mobileGroup}/providers/Microsoft.App/containerApps/mobile-api-prod`;
    const verifierTuple = principalId === verifierPrincipalId && roleName === "Reader" &&
      [mobileStorageAccount, prodApp].some(resource => resource.toLowerCase() === scope.toLowerCase());
    if (publisherTuple && !verifierTuple &&
        (!objectId.test(evidencePublisherPrincipalId ?? "") || principalId !== evidencePublisherPrincipalId)) return null;
    return mobileCard("az role assignment create", [principalId, roleName, scope.toLowerCase()],
      `Service principal ${principalId}, role ${roleName}, scope ${scope}`);
  }

  const isJob = withoutOutput.startsWith("az containerapp job create ");
  const isSecret = withoutOutput.startsWith("az keyvault secret set ");
  if (isSecret) {
    if (!withoutOutput.startsWith(evidencePinPrefix) || !allowedCreates.includes(evidencePinPrefix + "<utc-expiry> -o none")) return null;
    const expiry = mobileEvidenceExpiry(withoutOutput.slice(evidencePinPrefix.length));
    return expiry && mobileCard("az keyvault secret set", [evidencePinPrefix, expiry],
      `Evidence bootstrap pin, expires ${expiry}`);
  }
  if (!allowedCreates.includes(withoutOutput + " -o none")) return null;
  if (isJob && (tokens[tokens.indexOf("--image") + 1] !== publisherImage ||
      evidencePublisherGrants.length !== 8 ||
      new Set(evidencePublisherGrants.map(({ role, scope }) => JSON.stringify([role, scope.toLowerCase()]))).size !== 8 ||
      !evidencePublisherGrants.some(pin => sameGrant(pin, publisherReader.role, publisherReader.scope)) ||
      !objectId.test(evidencePublisherPrincipalId ?? "") ||
      !evidencePublisherGrants.every(({ role, scope }) => grantPrincipals.some(pin =>
        pin.principalId === evidencePublisherPrincipalId && sameGrant(pin, role, scope))))) return null;
  const scope = tokens.slice(0, tokens[1] === "identity" ? 3 : 4).join(" ");
  return mobileCard(scope, [withoutOutput], withoutOutput.slice(scope.length + 1));
}

export function matchPrdCard(command, cwd, targets) {
  // Claude Code can omit a leading cd to the current directory before PreToolUse.
  const issuerCommand = /^MOBILE_APPROVED_EVIDENCE_SHA256=[a-f0-9]{64}[ \t]+MOBILE_APPROVED_A0_SHA256=[a-f0-9]{64}[ \t]+node[ \t]+/.test(command)
    ? `cd ${cwd} && ${command}`
    : command;
  if (issuerCommand.startsWith("cd ") && /^[\x20-\x7e\t]+$/.test(issuerCommand)) {
    const issuer = matchMobileIssuer(issuerCommand.trim().split(/[ \t]+/), cwd);
    if (issuer) return issuer;
  }
  const mobile = matchMobileCard(command, targets);
  if (mobile) return mobile;
  const webDeploy = matchWebDeployCard(command, targets);
  if (webDeploy) return webDeploy;
  if (/[^\x20-\x7e\t]/.test(command)) return null;
  const cleanup = actionsCleanupCard(command.trim(), cwd);
  if (cleanup) return cleanup;
  const words = command.trim().split(/[ \t]+/);
  const issues = repoIssuesCard(words);
  if (issues) return issues;
  if (starts(words, ["az", "containerapp", "ingress", "traffic", "set"])) return trafficCard(words, targets);
  let cd;
  if (words[0] === "cd" && words[2] === "&&") {
    [, cd] = words.splice(0, 3);
    if (!path.test(cd)) return null;
  }
  // A restrictive lexer keeps shell expansions and compound commands out of the allowlist.
  if (words.some((word, i) => !/^[A-Za-z0-9_./~:@-]+$/.test(word) &&
      !(words[i - 1] === "--authorize" && authorize.test(word)))) return null;
  const azWrite = ["acr build", "containerapp update", "containerapp job update"].find(form => starts(words, ["az", ...form.split(" ")]));
  if (azWrite) {
    if (cd && azWrite !== "acr build") return null;
    let output = withOutputNone(words);
    const correction = output ? null : azOutputCorrection(words);
    if (correction) output = withOutputNone(correction.words);
    if (!output) return null;
    const matched = azWrite === "acr build" ? dbopsBuild(output.rest, cwd, cd) :
      azWrite === "containerapp update" ? appUpdate(output.rest, targets, output.quiet) : dbopsJob(output.rest);
    return matched && correction ? { scope: matched.scope, id: matched.id, denial: "card-gated PRD action: " + correction.hint } : matched;
  }
  if (cd) return null;
  if (words[1] === "migrate") return dbopsMigration(words, cwd, targets);
  if (words[0] === "node") return deploy(words, cwd, targets);
  if (starts(words, ["gh", "api", "-X"])) {
    const verb = words[3];
    const ruleset = verb === "PUT" ? rulesetCard(words, cwd) : verb === "POST" ? protectMainCard(words, cwd) : null;
    if (ruleset) return ruleset;
    if (["PUT", "POST", "PATCH", "DELETE"].includes(verb)) return branchProtectionCard(words, cwd);
  }
  return null;
}

function normalizedCard(command, id) {
  const words = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const operands = [];
  const flags = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith("-")) {
      operands.push(word);
    } else if (word.includes("=")) {
      const equal = word.indexOf("=");
      flags.push([word.slice(0, equal), word.slice(equal + 1)]);
    } else if (words[i + 1] && !words[i + 1].startsWith("-") && !["--rollback", "--stage-only", "--only-show-errors", "--confirm-staging"].includes(word)) {
      flags.push([word, words[++i].replace(/^(['""])(.*)\1$/, "$2")]);
    } else {
      flags.push([word]);
    }
  }
  // Normalize whitespace and flag order before reserving a card for this session.
  return JSON.stringify([id, operands, flags.sort()]);
}

function acquireLock(lock) {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST" || !lstatSync(lock).isDirectory()) throw error;
    const owners = readdirSync(lock);
    if (owners.length > 1) throw error;
    const owner = owners[0] && join(lock, owners[0]);
    const stat = lstatSync(owner || lock);
    if (owner && !stat.isFile()) throw error;
    let time = stat.mtimeMs;
    if (owner) {
      const data = readRegularFile(owner, 1024);
      try {
        const recorded = JSON.parse(data).time;
        if (Number.isFinite(recorded)) time = recorded;
      } catch {
        // A process can die after creating the record but before writing it.
      }
    }
    if (Date.now() - time <= 10_000) throw error;
    // Only the process that removes this unique owner record can reclaim its lock.
    if (owner) unlinkSync(owner);
    rmdirSync(lock);
    mkdirSync(lock, { mode: 0o700 });
  }
  const owner = join(lock, randomUUID());
  writeFileSync(owner, JSON.stringify({ pid: process.pid, time: Date.now() }), { flag: "wx", mode: 0o600 });
  return owner;
}

// The single-use ledger is defence in depth. CodeDen's allow-for-session is fixed in a separate CodeDen change.
export function reservePrdCard(command, sessionId, id, { claim, consume = false } = {}) {
  if (typeof sessionId !== "string" || !sessionId.trim()) return "card-gated PRD action: missing session_id";
  const testLedger = !claim && !consume && process.env.NODE_TEST_CONTEXT && process.env.CODEDEN_GUARD_LEDGER;
  const directory = testLedger || join(configDir, "prd-card-ledger.d");
  const ledger = join(directory, "prd-card-ledger.jsonl");
  const lock = ledger + ".lock";
  const actionSha = hash(normalizedCard(command, id));
  const sha256 = consume ? hash(JSON.stringify(["execution", actionSha])) : actionSha;
  const claimSha = claim ? hash(claim) : null;
  // The terminator makes even truncation at a complete entry boundary detectable.
  const terminator = "--end--\n";
  try {
    assertNoSymlinks(dirname(directory));
    let fresh = false;
    if (!consume) {
      try {
        mkdirSync(directory, { mode: 0o700 });
        fresh = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== userInfo().uid || (stat.mode & 0o777) !== 0o700) {
      throw new Error("unsafe ledger directory");
    }
    const owner = acquireLock(lock);
    try {
      const fd = openSync(ledger, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK |
        (fresh ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error("invalid ledger");
        const prior = readFileSync(fd, "utf8");
        if (!fresh && (!prior.endsWith(terminator) || prior === terminator)) throw new Error("incomplete ledger");
        const entries = prior.slice(0, -terminator.length);
        if (entries && !entries.endsWith("\n")) throw new Error("invalid ledger terminator");
        let authorized = !consume;
        for (const line of entries.split("\n").slice(0, -1)) {
          const entry = JSON.parse(line);
          if (typeof entry.at !== "string" || typeof entry.session_id !== "string" ||
              typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("invalid ledger entry");
          if (entry.session_id === sessionId && entry.sha256 === sha256) {
            return "card already raised for this command form in this session; start a new session or change the command";
          }
          if (consume && entry.session_id === sessionId && entry.sha256 === actionSha && entry.claim_sha256 === claimSha) {
            authorized = true;
          }
        }
        if (!authorized) return "no deploy approval recorded for this exact command";
        const entry = Buffer.from(JSON.stringify({ at: new Date().toISOString(), session_id: sessionId, sha256,
          ...(!consume && claimSha && { claim_sha256: claimSha }) }) + "\n" + terminator);
        if (writeSync(fd, entry, 0, entry.length, Buffer.byteLength(entries)) !== entry.length) {
          throw new Error("incomplete ledger write");
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } finally {
      unlinkSync(owner);
      rmdirSync(lock);
    }
  } catch {
    return "card-gated PRD action: could not reserve a single-use approval card in the ledger; treated as already asked";
  }
  return null;
}

export function creationType(head, path, args = []) {
  const verb = path.at(-1);
  const full = path.join(" ");
  if (head === "az" && !/^(?:repos|boards|pipelines|devops|artifacts)$/.test(path[0]) && (/^create(?:-|$)/.test(verb) || verb === "onboard" ||
      /^(?:containerapp up|webapp up|connectedmachine connect|sql db (?:copy|restore)|aks nodepool add)$/.test(full) ||
      full === "rest" && args.some((arg, i) => /^(?:-m|--method)=put$/i.test(arg) ||
        /^(?:-m|--method)$/.test(arg) && /^put$/i.test(args[i + 1])))) return head + " " + full;
  if (head === "azd" && /^(up|provision)$/.test(full) ||
      head === "azcmagent" && full === "connect" ||
      head === "terraform" && full === "apply" ||
      head === "pulumi" && full === "up") return head + " " + full;
  if (/^new-az[\w-]+$/.test(head)) return head;
  return null;
}

export function describeCreation(head, path, args) {
  const type = creationType(head, path, args);
  if (!type) return null;
  const fields = new Map();
  for (const [i, arg] of args.entries()) {
    const flag = /^(-n|--name|-name|-g|--resource-group|-resourcegroupname|-l|--location|-location)(?:[=:](.*))?$/i.exec(arg);
    if (!flag) continue;
    const value = flag[2] ?? args[i + 1];
    const key = flag[1].toLowerCase().replace(/^-+/, "");
    const field = key[0] === "r" ? "g" : key[0];
    fields.set(field, !fields.has(field) && /^[\w.-]+$/.test(value ?? "") && !value.startsWith("-") ? value : null);
  }
  const name = fields.get("n");
  const group = fields.has("g") ? fields.get("g") : /^(?:az group create|new-azresourcegroup)$/.test(type) ? name : null;
  const region = fields.get("l");
  return { type, args, name, group, region,
    reason: `NEW RESOURCE: owner authorization required (security rule 14): ${type} ${name ?? "unknown"} in ${group ?? "unknown"} (${region ?? "unknown"})` };
}

export function describeCreationTemplate(creation, cwd) {
  const files = creation.args.flatMap((arg, index) => {
    const flag = /^--template-file(?:=(.*))?$/.exec(arg);
    return flag ? [flag[1] ?? creation.args[index + 1]] : [];
  });
  if (files.length !== 1 || !path.test(files[0] ?? "") || files[0].startsWith("-") ||
      creation.args.some(arg => /^(?:-[fu](?:$|.)|--template-(?:uri|spec)(?:=|$))/.test(arg) ||
        /(?:^|=|^-p)@/.test(arg))) return null;
  try {
    const filename = resolve(cwd, expandHome(files[0]));
    const base = dirname(filename);
    const digests = new Map();
    let remaining = 4 * 1024 * 1024;

    function scan(file, depth) {
      if (digests.has(file)) return;
      if (depth > 32 || digests.size >= 128) throw new Error("template module limit exceeded");
      const bytes = readRegularFile(file, remaining);
      remaining -= bytes.length;
      digests.set(file, hash(bytes));
      for (const reference of templateReferences(file, bytes.toString("utf8"))) {
        if (!reference || isAbsolute(reference) || /[:\\]|\$\{/.test(reference)) {
          throw new Error("expected a literal relative module path");
        }
        scan(resolve(dirname(file), reference), depth + 1);
      }
    }

    scan(filename, 0);
    const modules = [...digests].slice(1).map(([file, digest]) => `module ${JSON.stringify(relative(base, file))} sha256 ${digest}`);
    return [`template ${filename} sha256 ${digests.get(filename)}`,
      "may deploy nested modules into other scopes: template sha256 covers the top-level file only", ...modules].join("; ");
  } catch {
    return null;
  }
}

function templateReferences(filename, source) {
  if (/\.bicep$/i.test(filename)) {
    // Read declarations while skipping comments and string values.
    const tokens = [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'''[\s\S]*?'''|'(?:\\.|[^'\\])*'|[\w]+|[^\s]/g)]
      .map(([token]) => token).filter(token => !token.startsWith("//") && !token.startsWith("/*"));
    return tokens.flatMap((token, i) => token === "module" && /^\w+$/.test(tokens[i + 1] ?? "") &&
      tokens[i + 2]?.startsWith("'") && tokens[i + 3] === "=" ? [tokens[i + 2].slice(1, -1)] : []);
  }
  const links = [];
  const pending = [JSON.parse(source.replace(/^\uFEFF/, ""))];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Object.hasOwn(value.templateLink ?? {}, "relativePath")) {
      const reference = value.templateLink.relativePath;
      if (typeof reference !== "string" || reference.startsWith("[")) throw new Error("nonliteral relative template link");
      links.push(reference);
    }
    for (const child of Object.values(value)) pending.push(child);
  }
  return links;
}
