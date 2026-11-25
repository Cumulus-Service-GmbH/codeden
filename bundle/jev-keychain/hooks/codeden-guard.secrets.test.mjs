import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkHookInput, checkAzure, checkCommand, checkSecrets, loadAzureTargets, metadataOnlyQuery, normalizeCmd } from './codeden-guard.mjs';

const targets = loadAzureTargets(new URL('./fixtures/azure-targets.json', import.meta.url));
const show = 'az keyvault secret show --vault-name kv-erpure-x -n s';
const metadata = '--query "{name:name,enabled:attributes.enabled,updated:attributes.updated}"';

test('line continuations are checked with and without a space', () => {
  for (const command of [
    'sql\\\ncmd -S erpure-sql',
    'sqlcmd -S erpure-\\\r\nsql',
    'az keyvault secret sh\\\now --vault-name kv-erpure-x -n s',
    'az keyvault secret \\\nshow --vault-name kv-erpure-x -n s',
  ]) {
    assert.ok(checkSecrets(command, targets), command);
    assert.ok(checkCommand(command, targets), command);
  }
  assert.equal(normalizeCmd('a\\\nb'), 'a b');
});

test('shell comments cannot supply the metadata query', () => {
  for (const tail of ['# --query name', ';# --query name', '\n# --query name', '# hidden\n--query name']) {
    assert.ok(checkSecrets(`${show} ${tail}`), tail);
  }
  assert.ok(checkSecrets(`${show} \\\n# --query name`));
  assert.ok(metadataOnlyQuery(`${show} --query "{'#label':name}"`));
  assert.ok(metadataOnlyQuery(`${show} -n "s#suffix" --query name`));
});

test('glued command substitutions cannot obscure Azure command words', () => {
  for (const command of [
    'az keyvault secret sh`true`ow',
    'az keyvault secret sh$(printf "")ow',
    'az key``vault secret show',
    'az keyvault secret $(printf sh)ow',
    'az keyvault secret "$(printf sh)ow"',
    'az keyvault secret "$(printf %s "$(printf sh)")"ow',
    'az keyvault secret show$(true)',
    'az keyvault secret show`true`',
  ]) assert.ok(checkSecrets(`${command} --vault-name kv-erpure-x -n s`), command);
});

test('Key Vault and SQL token resources are blocked', () => {
  for (const resource of [
    '--resource cfa8b339-82a2-471a-a3c9-0fc0be7a4093',
    '--resource=022907D3-0F1B-48F7-BADC-1BA6ABAB6D66',
    '--resource-type oss-rdbms',
    '--resource-type=oss-rdbms',
    '--resource https://vault.azure.net',
    '--scope https://vault.azure.net/.default',
    '--resource https://database.windows.net',
    '--resource https://ossrdbms-aad.database.windows.net',
  ]) assert.ok(checkSecrets(`az account get-access-token ${resource}`), resource);
});

test('SQL host matching recognizes inet_aton and mapped IPv6 forms', () => {
  for (const host of [
    '149.97.246.130', '149.97.63106', '149.6420098', '2506225282', '0x9561f682',
    '0x00009561f682', '022530373202', '0225.0141.0366.0202', '0x95.97.0xf682',
    '149.97.0366.0202',
    '::ffff:149.97.246.130', '::ffff:9561:f682', '0:0:0:0:0:FFFF:9561:F682',
  ]) assert.ok(checkSecrets(`sqlcmd -S tcp:[${host}],1433`), host);
  assert.ok(checkSecrets('python3 app.py "Server=0x95.97.0xf682,1433"'));
  assert.ok(checkSecrets('sqlcmd -S tcp:::ffff:9561:f682,1433'));
  assert.ok(checkSecrets('node app.mjs "mssql://[::ffff:9561:f682]:1433/db"'));
});

test('metadata and unrelated commands remain allowed', () => {
  for (const command of [
    'az keyvault secret list --vault-name kv-erpure-x',
    `${show} ${metadata}`,
    'az account get-access-token --resource https://management.azure.com',
    'curl http://149.97.246.13/x',
    'sqlcmd -S 149.97.246.13',
    'sqlcmd -S 0x9561f683',
    'sqlcmd -S [::ffff:9561:f683]',
    'git log',
    'sqlite3 x.db',
  ]) {
    assert.equal(checkSecrets(command, targets), null, command);
    // The full guard still applies its existing Azure write and token-output rules.
    assert.equal(checkCommand(command, targets), checkAzure(command, targets), command);
  }
});

test('previously denied secret and SQL commands remain blocked', () => {
  for (const command of [
    show,
    `${show} --query value`,
    `${show} --query name --debug`,
    `${show} --query name --query id`,
    'az keyvault secret backup --vault-name kv-erpure-x -n s',
    'az containerapp secret list -n erpure-x --show-values',
    'az containerapp show -n erpure-x --query properties.template.containers',
    'az functionapp config connection-string list -n erpure-x',
    'az rest --url https://kv-x.vault.azure.net/secrets',
    'sqlcmd -S "$SERVER"',
    'sqlcmd -S erpure-sql',
  ]) {
    assert.ok(checkSecrets(command, targets), command);
    assert.ok(checkCommand(command, targets), command);
  }
});

test('metadata allowance requires one simple command with its own query', () => {
  for (const command of [
    "x=$'\\''; " + show + " # --query name '",
    'echo "$(echo "\'")"; ' + show + " # --query name '",
    `${show}; : --query name`,
    `${show} \\\n# --query name`,
    `${show} --query name --de''bug`,
    `${show} --query name --deb\\ug`,
    `${show} --query name --ver\\\nbose`,
    `${show} --query name > output`,
    `${show} --query name < input`,
    `${show} --query name &`,
    `${show} --query name | cat`,
    `${show} --query name --vault-name \${vault}`,
    `${show} -n "s --query name "`,
    `${show} -n s#suffix --query name`,
  ]) {
    assert.ok(checkSecrets(command, targets), command);
    assert.equal(metadataOnlyQuery(command), false, command);
  }
});

test('substitutions and literal splices cannot hide Azure secret commands', () => {
  for (const command of [
    'a$(true)z keyvault secret show --vault-name kv-erpure-x -n s',
    'a`true`z keyvault secret show --vault-name kv-erpure-x -n s',
    "a''z keyvault secret show --vault-name kv-erpure-x -n s",
    'a\\z keyvault secret show --vault-name kv-erpure-x -n s',
    'az keyvault secret $(printf show) --vault-name kv-erpure-x -n s',
    'az keyvault secret `printf show` --vault-name kv-erpure-x -n s',
    "az account get-access-token --resource $(printf 'cfa8b339%s' -82a2-471a-a3c9-0fc0be7a4093)",
    'az keyvault secret show --vault-name `printf kv-erp%s-x ure` -n s',
    'a$(printf "%s" "$(true)")z keyvault secret show',
    'az$(true)keyvault secret show',
  ]) {
    assert.ok(checkSecrets(command, targets), command);
    assert.ok(checkCommand(command, targets), command);
  }
});

test('non-secret Azure commands can use incidental substitutions', () => {
  for (const command of [
    'az storage blob upload --name "r-$(date +%F).json"',
    'az storage blob upload --name "report-$(date +%F).json" -c logs -f r.json --account-name devacct',
    'az acr build --image "app:$(git rev-parse --short HEAD)"',
    'az acr build --image "app:$(git rev-parse --short HEAD)" -r myacr .',
    'rg=$(cat rg.txt) && az group show -n "$rg"',
    'SUB=$(az account show --query id -o tsv)',
    'az group list --subscription "$(az account show --query id -o tsv)"',
    'az sql db list --server "$(cat server.txt)" -g rg-dev',
    'az group list --subscription "$(cat account.txt)"; echo secrets',
    'echo "$(date)"; az keyvault secret list --vault-name kv-dev',
    'az storage blob upload --name "$(cat name.txt)" && az rest --url https://management.azure.com/config/',
  ]) {
    assert.equal(checkSecrets(command, targets), null, command);
    assert.equal(checkCommand(command, targets), checkAzure(command, targets), command);
  }
});

test('round 4 secret and SQL shapes are denied by local classification', () => {
  const cases = [
    ['H1 global flags', 'az --debug --output json --subscription dev keyvault secret show --vault-name kv-erpure-x'],
    ['H1 only-show-errors', 'az --only-show-errors containerapp revision list -n erpure-x'],
    ['H1 verbose and inline flag', 'az --verbose --query=name staticwebapp appsettings list -n erpure-x'],
    ['H2 metadata with a variable', show + ' --query name "$EXTRA"'],
    ['H3 indirect argument', 'az keyvault secret show --vault-name @target.txt'],
    ['H4 token audience', 'az account get-access-token --resource "$AUDIENCE"'],
    ['H4 REST URL', 'az rest --method get --url "$ENDPOINT"'],
    ['H4 REST substitution', 'az rest --method get --url "https://management.azure.com/subscriptions/$(cat id.txt)"'],
    ['H4 dynamic fourth word', 'az webapp config appsettings "$VERB"'],
    ['H4 function keys fourth word', 'az functionapp function keys "$VERB"'],
    ['H4 abbreviated values', 'az containerapp secret list -n erpure-x --show-v'],
    ['H4 expanded flag', 'az containerapp secret list -n erpure-x "$FLAG"'],
    ['H5 SQL instance delimiter', 'sqlcmd -S "149.6420098\\instance,1433"'],
    ['H6 wrapper', 'az-wrapper keyvault secret show --vault-name kv-erpure-x'],
    ['H6 prefixed wrapper', 'python3 wrapper.py keyvault secret show --vault-name kv-erpure-x'],
    ['H6 Python module', 'python3 -m azure.cli --only-show-errors containerapp secret show -n erpure-x'],
    ['M6 ARM HTTP client', 'curl https://management.azure.com/app/config/appsettings/list'],
  ];
  for (const [shape, command] of cases) assert.ok(checkSecrets(command, targets), shape);
  assert.equal(metadataOnlyQuery(show + ' --query name "$EXTRA"'), false);
  assert.ok(metadataOnlyQuery(show + " --query name -n 'literal$'"));
  assert.match(checkCommand("se''curity find-generic-password"), /reading the macOS keychain/);
  assert.match(checkSecrets(show), /single command, no pipes, redirects, variables or substitutions/);
});

test('round 4 literal URLs, home paths and deployment arguments remain allowed', () => {
  for (const command of [
    'az rest --url "https://management.azure.com/subscriptions?api-version=2022-12-01"',
    '~/bin/az keyvault secret list --vault-name kv-dev',
    'az containerapp update -n api -g rg-dev --image "myacr.azurecr.io/api:$(git rev-parse --short HEAD)"',
    'az webapp deploy -n app-dev -g rg-dev --src-path "dist-$(date +%s).zip"',
  ]) {
    assert.equal(checkSecrets(command, targets), null, command);
    assert.equal(checkCommand(command, targets), checkAzure(command, targets), command);
  }
});

test('SQL hosts are recognized after attached flags and protocol prefixes', () => {
  for (const server of [
    '-S149.6420098', '-S022530373202', '-S0225.0141.0366.0202',
    '-S0x95.97.0xf682', '-S::ffff:9561:f682',
    '-S admin:::ffff:9561:f682', '-S np:::ffff:9561:f682',
    '-S lpc:::ffff:9561:f682', '-Stcp:149.6420098',
  ]) assert.ok(checkSecrets(`sqlcmd ${server}`), server);
});

test('SQL token audiences are blocked with abbreviated resource flags', () => {
  for (const audience of ['oss-rdbms', 'ossrdbms']) {
    assert.ok(checkSecrets(`az account get-access-token --resource-t ${audience}`), audience);
  }
});

test('substitution denial is scoped to Azure secret and config invocations', () => {
  for (const command of [
    'az keyvault secret list --vault-name "$(cat vault.txt)"',
    'az rest --method get --url "https://management.azure.com/config/$(cat endpoint.txt)"',
  ]) assert.match(checkSecrets(command, targets), /command substitution in an Azure secret\/config command/, command);
});

test('sensitive Azure command words and executable names must be literal', () => {
  for (const command of [
    '"/opt/bin/a"z.exe account "$VERB"',
    'az containerapp revision sh*',
    'az webapp config "$(cat kind.txt)"',
    'az functionapp "$ACTION"',
    'az keyvault sec?et list',
    'az rest "$METHOD"',
    '"$CLI" keyvault secret list',
    'echo "$(az account "$VERB")"',
  ]) assert.match(checkSecrets(command, targets), /nonliteral Azure/, command);
});

test('SQL client server arguments must be literal', () => {
  for (const command of [
    '"/opt/bin/go-sqlcmd.exe" -S "$(cat server.txt)"',
    'osql -Sdev-*',
    'isql --server=dev-?',
    'tsql --server dev-[123]',
    'bcp -S"dev-$SUFFIX"',
    'bcp -S <(cat server.txt)',
    'mssql-cli --server="$(cat server.txt)"',
    'sqlpackage --server="dev-*"',
    'Invoke-Sqlcmd -ServerInstance:"dev-$SUFFIX"',
  ]) assert.match(checkSecrets(command, targets), /SQL client whose server/, command);
});

test('commands over 64 KB fail closed before structural analysis', () => {
  const padding = 'é'.repeat(32 * 1024);
  for (const command of [
    `az group list # ${padding}`,
    `"/opt/bin/go-sqlcmd.exe" -S dev # ${padding}`,
    `'a'z group list # ${padding}`,
  ]) assert.match(checkSecrets(command, targets), /exceeds 64 KB/);
  assert.equal(checkSecrets(`az group list #${' '.repeat(65536 - 'az group list #'.length)}`), null);
  assert.match(checkSecrets(`echo ${padding}`), /too large for structural analysis/);
});

const round5Denied = [
  ['H1 dynamic group', 'az "$GROUP" secret show --vault-name kv-erpure-test'],
  ['H2 brace expansion', 'az key{vault,other} secret show --vault-name kv-erpure-test'],
  ['H1 ANSI-C group', "az $'keyvault' secret show --vault-name kv-erpure-test"],
  ['H2 target brace', 'az keyvault secret show --vault-name kv-er{pure}--test'],
  ['H2 query brace', show + ' --query name --{query=value,query=value}'],
  ['H2 debug brace', show + ' --query name --de{bug,bug}'],
  ['H2 show flag brace', 'az containerapp secret list -n app-erpure-test --sh{ow,ow}-values'],
  ['H2 flag glob', 'az containerapp secret list -n app-erpure-test --sh*'],
  ['H3 launcher', 'timeout 10 /opt/bin/az --only-show-errors containerapp show -n app-erpure-test'],
  ['H3 launcher with debug', 'timeout 10 /opt/bin/az --debug keyvault secret list --vault-name kv-erpure-test'],
  ['H3 module launcher', 'timeout 10 python3 -I -m azure.cli --output json containerapp show -n app-erpure-test'],
  ['M1 show prefix', 'az containerapp secret list -n app-erpure-test --sh'],
  ['M1 duplicate equals query', show + ' --query name --q=value'],
  ['M1 duplicate query', show + ' --query name --qu value'],
  ['M2 dynamic SQL client and host', "ts$'ql' -H er{pure}-test"],
  ['M2 SQL host flag', "t''sql -H 149.97.246.130"],
  ...['/servername:', '/sourceservername:', '/targetservername:', '/tsn:', '/ssn:']
    .map(flag => ['M2 SQL server flag', `runner ${flag}149.97.246.130`]),
  ['M3 keychain splice', "security dump''-keychain"],
  ['M3 keychain program splice', 'secu$(printf %s rity) find-internet-password'],
  ['M3 keychain argument splice', 'security find-$(true)generic-password'],
  ['M4 static app settings', 'curl https://management.azure.com/a/listAppSettings'],
  ['M4 ARM endpoint', 'curl https://management.azure.com/a/listFunctionAppSettings'],
  ['M4 dynamic URL', 'curl "https://management.azure.com/${ENDPOINT}"'],
  ['M4 dynamic vault URL', 'curl "https://kv-erpure-test.vault.azure.net/${ENDPOINT}"'],
  ['M5 job secret show', 'az containerapp job secret show -n app-erpure-test'],
  ['M5 job secret list with values', 'az containerapp job secret list -n app-erpure-test --sh'],
  ['M5 job metadata query', 'az containerapp job show -n app-erpure-test'],
  ['M6 mixed-case Azure executable', '/opt/bin/Az.ExE containerapp job secret show -n app-erpure-test'],
  ['L1 large IPv4 integer', 'sqlcmd -S 18446744076215776898'],
  ['L2 undashed SQL token audience', 'az account get-access-token --resource 022907d30f1b48f7badc1ba6abab6d66'],
  ['L2 undashed token audience', 'az account get-access-token --resource cfa8b33982a2471aa3c90fc0be7a4093'],
  ['M7 vault debug', 'az keyvault secret list --vault-name "$VAULT" --de\'\'bug'],
  ['M7 extra expansion', 'az keyvault secret list --vault-name "$VAULT" "$EXTRA"'],
  ['M7 non-ARM audience', 'TOKEN=$(az account get-access-token --resource "$AUDIENCE" --subscription "$SUB" --query accessToken -o tsv)'],
  ['L5 configured PRD', 'az keyvault secret show --vault-name kv-configured-test'],
];
const round5Allowed = [
  'TOKEN=$(az account get-access-token --resource https://management.azure.com --tenant "$TENANT" --query accessToken -o tsv)',
  'az keyvault secret list --vault-name "$VAULT"',
  'TOKEN=$(az account get-access-token --resource https://management.azure.com --subscription "$SUB" --query accessToken -o tsv)',
  'az containerapp update -n api -g rg-dev --image "myacr.azurecr.io/api:$(git rev-parse --short HEAD)"',
  'az webapp deploy -n app-dev -g rg-dev --src-path "dist-$(date +%s).zip"',
  'SUB=$(az account show --query id -o tsv)',
  'az group list --subscription "$(az account show --query id -o tsv)"',
  'az containerapp job list -n app-erpure-test --qu name',
  `${show} ${metadata}`,
];

test('round 5 denial and allowance cases through the classifier and full guard', () => {
  for (const [finding, command] of round5Denied) {
    assert.ok(checkSecrets(command, targets), finding);
    assert.ok(checkCommand(command, targets), finding);
  }
  for (const command of round5Allowed) {
    assert.equal(checkSecrets(command, targets), null, command);
    assert.equal(checkCommand(command, targets), null, command);
  }
});

test('guard allows harmless prose, metadata arguments and ARM capture', () => {
  for (const command of [
    'rg -n "vault.azure.net" src/',
    'git log -S management.azure.com',
    'jq \'.KeyVault.Uri="https://kv-qa.vault.azure.net/"\' appsettings.json',
    'nslookup kv-dev.vault.azure.net',
    'git commit -m "Move vault.azure.net metadata"',
    "gh pr create --body \"$(cat <<'END'\n* containerapp appsettings\nEND\n)\"",
    'cat > notes.md <<END\n* containerapp appsettings\nEND',
    'PATH="$PWD/bin:$PATH" az keyvault secret list --vault-name "$VAULT"',
    'az containerapp show -n "${APP}" -g "$RG" --query name',
    'az keyvault secret list --vault-name kv-erpure-wc-mcp-eus --query [].name -o tsv',
    "az keyvault secret list --query '[?attributes.enabled==`true`].name'",
    'az keyvault secret list --query "[?attributes.enabled==\\`true\\`].name"',
    "bash -c 'true'",
    'sqlpackage -SourceFile:"$DACPAC"',
    'cd /x && az keyvault secret show --vault-name kv-erpure-test --query "{name:name}"',
    'TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv) && curl -s -H "Authorization: Bearer $TOKEN" https://example.invalid >/dev/null',
    'TOKEN=$(az account get-access-token --resource https://management.azure.com --subscription "$SUB" --query accessToken -o tsv)',
  ]) assert.equal(checkCommand(command, targets), null, command);
});

test('guard denies dynamic execution and unchecked secret arguments', () => {
  for (const command of [
    '"$PYTHON" tools/check.py src/Api/appsettings.json',
    '"$AZ_SCRIPT" tools/check.py src/Api/appsettings.json',
    'eval "echo ok"', 'source <(cat script.sh)', 'source "$FILE"',
    'bash -c "$SCRIPT"', 'cat script.sh | xargs sh -c',
    'cat script.py | python', 'cat script.js | node', 'cat script.scpt | osascript',
    'bash -c "az keyvault secret show --vault-name kv-erpure-test"',
    'node -e \'fetch(atob(input))\'', 'pwsh -EncodedCommand Zg==',
    'nice az --debug keyvault secret show --vault-name kv-erpure-test',
    'AZ containerapp update -n app-erpure-test',
    'security export-keychain', 'security "$OP"',
    'az containerapp secret list -n app-erpure-test --sh',
    'az containerapp show -n app-erpure-test --query name --que properties',
    'az containerapp job secret list -n app-erpure-test',
    'az containerapp job list -g sandbox',
  ]) assert.ok(checkCommand(command, targets), command);
});

test('hook checks script writes from a CodeDen project after cwd changes', () => {
  const code = 'az keyvault secret show --vault-name kv-erpure-test';
  const project = process.env.CODEDEN_HOME || process.env.HOME + '/.codeden';
  for (const [tool_name, tool_input] of [
    ['Write', { file_path: 'script.sh', content: code }],
    ['Write', { file_path: 'script', content: '#!/bin/bash\n' + code }],
    ['Edit', { file_path: 'script.js', new_string: `execSync(${JSON.stringify(code)});` }],
    ['Edit', { file_path: 'script.mjs', new_string: `execFileSync("az", ${JSON.stringify(code.split(' ').slice(1))});` }],
    ['MultiEdit', { file_path: 'script.py', edits: [{ new_string: 'pass' }, { new_string: `subprocess.run(${JSON.stringify(code)}, shell=True)` }] }],
  ]) assert.match(checkHookInput({ cwd: '/tmp', tool_name, tool_input }, targets, project + '/wt/example'), /script/);
  assert.equal(checkHookInput({ cwd: project + '/wt/example', tool_name: 'Write',
    tool_input: { file_path: 'notes.md', content: code } }, targets), null);
});

test('hook executable fails closed on parse and processing errors in CodeDen', () => {
  const hook = fileURLToPath(new URL('./codeden-guard.mjs', import.meta.url));
  const env = { ...process.env, CODEDEN_HOME: '/tmp/guard-test-home', CLAUDE_PROJECT_DIR: '/tmp/guard-test-home/wt/example' };
  const run = (input, overrides) => spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env: { ...env, ...overrides } });
  const malformed = run('{');
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /codeden-guard internal error: invalid JSON/);
  const processing = run(JSON.stringify({ cwd: '/tmp', tool_name: 'MultiEdit', tool_input: { edits: {} } }));
  assert.equal(processing.status, 2);
  assert.match(processing.stderr, /codeden-guard internal error:/);
  assert.equal(run('{', { CLAUDE_PROJECT_DIR: '/tmp' }).status, 0);
  const denied = run(JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: {
    command: 'az keyvault secret show --vault-name kv-erpure-test',
  } }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /metadata-only --query/);
  assert.equal(run(JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'git status' } })).status, 0);
});

test('host encodings and SQL server flag variants are denied through checkCommand', () => {
  for (const command of [
    'Invoke-Sqlcmd -ServerInstance:::ffff:9561:f682',
    'Invoke-Sqlcmd -ServerInstance [64:ff9b::9561:f682]',
    'sqlpackage /TargetServerName:18446744076215776898',
    'sqlpackage /ssn:"$SERVER"',
    'Invoke-Sqlcmd -ServerInstance "$SERVER"',
  ]) assert.match(checkCommand(command, targets), /SQL client/, command);
});

test('pipes distinguish interpreter source from data supplied to inline code', () => {
  for (const command of [
    'az account get-access-token -o json | node -e "process.stdin.resume()"',
    "printf data | python -c 'print(input())'",
    'printf data | node reader.mjs',
    "printf data | python -I -c 'print(input())'",
  ]) assert.equal(checkCommand(command, targets), null, command);
  for (const receiver of ['sh', 'bash', 'zsh', 'python', 'python -', 'node', 'node -',
    'node - -e ignored', 'node -i', 'pwsh -', 'osascript', 'xargs sh -c']) {
    assert.match(checkCommand('printf data | ' + receiver, targets), /pipe into a shell or interpreter/, receiver);
  }
  assert.equal(checkCommand("printf data | node reader.mjs -e 'exec(atob(input))'", targets), null);
  assert.match(checkCommand("printf data | python -c 'subprocess.run(chr(97))'", targets), /inline interpreter code/);
});

test('shell and interpreter checks inspect executable heredocs and inline literals', () => {
  assert.match(checkCommand('bash <<EOF\naz keyvault secret show --vault-name kv-erpure-test\nEOF', targets), /metadata-only/);
  assert.match(checkCommand("bash -c 'AZ containerapp update -n app-erpure-test'", targets), /az containerapp update/);
  for (const command of [
    "python -c 'subprocess.run(chr(97))'",
    "perl -e 'system(decode(input))'",
    "ruby -e 'system(decode(input))'",
    "php -r 'system(base64_decode(input));'",
    `osascript -e 'do shell script ("echo " & "hello")'`,
    "powershell -Command:'Invoke-WebRequest ([char]97)'",
    "deno eval 'fetch(atob(input))'",
    "bun -e 'fetch(atob(input))'",
  ]) assert.match(checkCommand(command, targets), /inline interpreter code/, command);
});

test('token audiences are checked even when the token is captured', () => {
  for (const args of [
    '--resource https://sql.azuresynapse.net',
    '--resource-type vault',
    '--resource-type oss-rdbms',
    '--resource cfa8b33982a2471aa3c90fc0be7a4093',
    '--resource "$PREFIX$SUFFIX"',
  ]) assert.ok(checkCommand('TOKEN=$(az account get-access-token ' + args + ')', targets), args);
});

test('default Azure targets are loaded once across secret and write checks', () => {
  const hook = new URL('./codeden-guard.mjs', import.meta.url).href;
  const fixture = new URL('./fixtures/azure-targets.json', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    let count = 0;
    fs.readFileSync = function (path, ...args) {
      if (typeof path === 'string' && path.endsWith('/trioharness/azure-targets.json')) {
        count++;
        return read(new URL(${JSON.stringify(fixture)}), ...args);
      }
      return read(path, ...args);
    };
    syncBuiltinESMExports();
    const { checkCommand } = await import(${JSON.stringify(hook)});
    assert.match(checkCommand('az keyvault secret show --vault-name kv-configured-test'), /metadata-only/);
    assert.match(checkCommand('AZ keyvault update --name kv-configured-test'), /PRD/);
    assert.equal(count, 1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('ordinary launcher, interpreter, Azure and prose arguments are allowed', () => {
  for (const command of [
    'cmd | xargs grep node', 'cmd | xargs -p grep node', 'timeout 10 rg sh', 'env FOO=1 cp . "$DEST"',
    'timeout 30 npm run eval', 'rg az "$DIR"',
    'git diff "$BASE" -- src/azure/keyvault/', 'echo "${AZURE_KEYVAULT_URL}"',
    'rg vault.azure.net/secrets',
    'node -e \'console.log(`value ${Buffer.from("a")}`)\'',
    'python tool.py -c "$CFG"', 'node script.mjs -p "$X"', 'node script.mjs -e',
  ]) assert.equal(checkCommand(command, targets), null, command);
});

test('ordinary Azure SDK and config-loader source is allowed on write and edit', () => {
  const cwd = process.env.HOME + '/.codeden/wt/guard-test';
  for (const [file_path, content] of [
    ['/tmp/config.ts', 'const keyVault = new SecretClient(`https://${name}.vault.azure.net`, credential);\nconst { appSettings, connectionString } = config;'],
    ['/tmp/config.js', 'const text = `keyVault: ${cfg.keyVault}`; const mask = flags | node;\nexecFile("rg", ["az keyvault secret show", "docs"]);'],
    ['/tmp/fixture.ts', 'const fixture = "https://mock.vault.azure.net/secrets/test";'],
    ['/tmp/config.py', 'settings = {"keyVault": os.getenv("VAULT"), "connectionString": config["db"]}\n'],
  ]) {
    for (const [tool_name, fields] of [
      ['Write', { content }], ['Edit', { new_string: content }], ['MultiEdit', { edits: [{ new_string: content }] }],
    ]) assert.equal(checkHookInput({ cwd, tool_name, tool_input: { file_path, ...fields } }, targets), null);
  }
});

test('heredoc script writes are inspected before a later script invocation', () => {
  for (const header of ['cat > run.sh', 'tee run.sh', 'cat > run', 'tee run.md']) {
    const path = header.split(' ').at(-1);
    assert.match(checkCommand(`${header} <<'END'\n#!/bin/sh\n${show}\nEND\nsh ${path}`, targets), /metadata-only/);
  }
  for (const header of ['cat > run.sh', 'tee run.sh']) {
    assert.match(checkCommand(`${header} <<'END'\n${show}\nEND\nsh run.sh`, targets), /metadata-only/);
  }
  assert.match(checkCommand(`tee notes.rst <<'END'\n${show}\nEND`, targets), /metadata-only/);
});

test('shell control words and piped groups preserve command context', () => {
  for (const command of [
    'if true; then eval true; fi', '{ eval true; }',
    'printf data | { true; sh; }', 'printf data | (true; sh)',
    'sh < input', 'sh <(printf data)', 'sh <<< data', 'sh<<<data', 'sh 0<input', '$(printf true)', '"$@"',
  ]) assert.match(checkCommand(command, targets), /unchecked/);
});

test('Azure global options and module entrypoints preserve the classified path', () => {
  assert.match(checkCommand(show.replace(' secret ', ' --sub fixture secret '), targets), /az keyvault:.*qa\/test list/);
  assert.match(checkCommand(show.replace('az ', 'az --out json '), targets), /az with no command: cannot classify/);
  for (const command of [
    show.replace('az ', 'python -mazure.cli '),
    show.replace('az ', 'python3 --check-hash-based-pycs default -m azure.cli '),
    show.replace('az ', 'python -Im azure.cli '),
    show.replace('az ', 'python -u azure-wrapper.py '),
    show.replace('az ', 'python -m azure.cli.__main__ '),
  ]) assert.match(checkCommand(command, targets), /metadata-only/);
});

test('interpreter options and heredocs inspect computed process code', () => {
  for (const command of [
    "python -uc 'subprocess.run(chr(97))'", "perl -E 'system(chr(97))'",
    "python <<'END'\nsubprocess.run(chr(97))\nEND",
    "if true; then env python <<'END'\nsubprocess.run(chr(97))\nEND\nfi",
    "pwsh -enco Zg==",
  ]) assert.match(checkCommand(command, targets), /(?:interpreter code|interpreter heredoc|encoded commands)/);
});

test('pipeline context survives compound command boundaries', () => {
  for (const receiver of ['if true; then sh; fi', 'while false; do sh; done',
    'case x in x) sh;; esac', '>/dev/null sh', '2>&1 sh']) {
    assert.match(checkCommand('printf data | ' + receiver, targets), /pipe into/, receiver);
  }
  assert.match(checkCommand('>/dev/null eval true', targets), /eval/);
});

test('ordinary PowerShell, batch and shell edits are allowed', () => {
  const cwd = '/tmp/guard-test-home/wt/example';
  for (const [file_path, new_string] of [['x.ps1', '$name = "example"'],
    ['x.bat', '@echo off'], ['x.sh', 'source "$DIR/lib.sh"\nexec "$@"']]) {
    assert.equal(checkHookInput({ cwd, tool_name: 'Edit', tool_input: { file_path, new_string } },
      targets, process.env.HOME + '/.codeden/wt/guard-test'), null, file_path);
  }
});

test('Codex outside CodeDen allows ordinary dynamic commands', () => {
  const hook = fileURLToPath(new URL('./codeden-guard.mjs', import.meta.url));
  for (const command of ['$(go env GOPATH)/bin/tool', 'eval "$(brew shellenv)"',
    'source "$VENV/bin/activate"', '"$PYTHON" script.py']) {
    const result = spawnSync(process.execPath, [hook, 'codex'], { encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: '/tmp' },
      input: JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command } }) });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('raw checks see both executable heredocs and prose', () => {
  const marker = 'echo --no-verify';
  for (const command of [
    [": <<'OUTER'", "cat > notes.md <<'INNER'", 'OUTER', marker, 'INNER'].join('\n'),
    ["cat > notes.md <<'END'", marker, 'END', 'sh notes.md'].join('\n'),
  ]) assert.match(checkCommand(command, targets), /no-verify/);
  assert.match(checkCommand(`gh pr create --body "Document ${show}"`, targets), /metadata-only/);
  assert.match(checkCommand('git commit -m "docs: mention security find-generic-password"', targets), /keychain/);
  assert.match(checkCommand('az bicep build "$FILE"', targets), /names no resource/);
});

test('hook enforces through a symlink and fails closed when its rules module is missing', t => {
  const directory = mkdtempSync(join(process.cwd(), '.guard-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hook = fileURLToPath(new URL('./codeden-guard.mjs', import.meta.url));
  const linked = join(directory, 'link.mjs');
  const isolated = join(directory, 'codeden-guard.mjs');
  symlinkSync(hook, linked);
  copyFileSync(hook, isolated);
  const env = { ...process.env, CODEDEN_HOME: directory, CLAUDE_PROJECT_DIR: '' };
  const run = (entry, cwd, ...args) => spawnSync(process.execPath, [entry, ...args], {
    env, encoding: 'utf8', input: JSON.stringify({ cwd, tool_name: 'Bash',
      tool_input: { command: 'echo --no-verify' } }),
  });
  const cwd = join(directory, 'wt/example');
  const denied = run(linked, cwd);
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /no-verify/);
  for (const result of [run(isolated, cwd), run(isolated, directory, 'codex'), run(isolated, directory)]) {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /codeden-guard internal error:.*codeden-guard-secrets\.mjs/);
  }
  assert.equal(run(linked, directory).status, 0);
});

test('literal script paths are inspected relative to hook cwd', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-script-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'notes.md'), 'echo --no-verify\n');
  writeFileSync(join(cwd, 'ordinary.sh'), 'exec "$@"\n');
  mkdirSync(join(cwd, 'sub'));
  writeFileSync(join(cwd, 'sub', 'runtime.sh'), 'echo --no-verify\n');
  for (const command of ['cd sub && sh runtime.sh', 'env -C sub sh runtime.sh']) {
    assert.match(checkCommand(command, targets, 0, { cwd }), /no-verify/, command);
  }
  assert.equal(checkCommand('bash ordinary.sh', targets, 0, { codex: true, cwd }), null);
  writeFileSync(join(cwd, 'sample.py'), 'print("hello")\n');
  writeFileSync(join(cwd, 'large.sh'), ' '.repeat(256 * 1024 + 1));
  const project = process.env.HOME + '/.codeden/wt/guard-test';
  for (const command of ['sh notes.md', 'source ./notes.md', '. notes.md', 'python sample.py', 'sh large.sh']) {
    const reason = checkHookInput({ cwd, tool_name: 'Bash', tool_input: { command } }, targets, project);
    if (command.startsWith('python')) assert.equal(reason, null);
    else assert.match(reason, command.endsWith('large.sh') ? /inspection limits/ : /no-verify/);
  }
});

test('interpreter bundles and heredocs inspect computed evaluation', () => {
  for (const [command, reason] of [
    ["node -pe 'eval(atob(input))'", /interpreter code/],
    ["node -p -e 'Function(atob(input))'", /interpreter code/],
    ["bun -pe 'eval(atob(input))'", /interpreter code/],
    ["python -Ec 'eval(chr(49))'", /interpreter code/],
    ["python -dc 'compile(chr(49), filename, mode)'", /interpreter code/],
    ["ruby -ne 'eval(chr(49))'", /interpreter code/],
    ["perl -Te 'eval decode(input)'", /interpreter code/],
    ["php -r 'eval(base64_decode(input));'", /interpreter code/],
    ["pwsh -cwa '[scriptblock]::Create([char]49)'", /interpreter code/],
    ["fish --command='eval true'", /eval/],
    ["python <<'END' 2>/dev/null\neval(chr(49))\nEND", /interpreter heredoc/],
  ]) assert.match(checkCommand(command, targets), reason, command);
});

test('launchers and compound functions are inspected through the hook', () => {
  for (const receiver of ['arch sh', 'doas sh', 'flock lock sh', 'uvx sh', 'uv run sh',
    'poetry run sh', 'npx sh', 'pnpm exec sh', 'bunx sh', 'busybox sh', 'script output sh', 'watch sh']) {
    assert.match(checkCommand('printf data | ' + receiver, targets), /pipe into/, receiver);
  }
  assert.match(checkCommand('reader() { sh; }; printf data | reader', targets), /pipe into a shell function/);
  assert.match(checkCommand("env -S 'printf hello world'", targets), /env split-string/);
  assert.equal(checkCommand('find . -exec printf hello \\;', targets), null);
  assert.equal(checkCommand("awk 'BEGIN { system(\"true\") }'", targets), null);
});

test('Codex accepts unrelated commands when Azure target configuration is unavailable', () => {
  const hook = fileURLToPath(new URL('./codeden-guard.mjs', import.meta.url));
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = function (path, ...args) {
      if (typeof path === 'string' && path.endsWith('/trioharness/azure-targets.json')) {
        throw new Error('configuration unavailable');
      }
      return read(path, ...args);
    };
    syncBuiltinESMExports();
  `;
  const preload = 'data:text/javascript,' + encodeURIComponent(source);
  const result = spawnSync(process.execPath, ['--import', preload, hook, 'codex'], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/tmp' },
    encoding: 'utf8', input: JSON.stringify({ cwd: '/tmp', tool_name: 'Bash',
      tool_input: { command: 'rg "az " src' } }),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('ordinary launcher and interpreter arguments remain allowed', () => {
  for (const command of [
    'env FOO=1 git log -S needle', 'flock lock bash -c "echo ok"',
    'pnpm run eval', 'pnpm add sh', 'pnpm install', 'uv pip install python',
    'poetry install', 'node -v', 'python3 -V', 'bun -v', 'ruby -v', 'perl -v',
    `node -e 'const fs = require("fs"); Buffer.from("text")'`,
    String.raw`python3 -c 'import re; re.compile(r"\x1b")'`,
    "awk '{print $1}'", "awk -F, '{print $1 \" | \" $2}'",
    "cat > notes.md <<'END'\n* keyvault secret list\nEND",
    'bash ./home/.claude/hooks/fixtures',
  ]) assert.equal(checkCommand(command, targets, 0, { codex: true, cwd: process.cwd() }), null, command);
  assert.match(checkCommand('gh pr create --body "https://kv-dev.vault.azure.net/secrets/example"', targets),
    /Azure secret store/);
});

test('the interpreter classifier checks inline operands and each heredoc body', () => {
  for (const command of [
    "node -e '-eval(atob(input))' dummy",
    "ruby -r library -e 'puts 1' -e 'eval chr(49)'",
    "deno eval --ext=js 'eval(String.fromCodePoint(49))'",
    "perl -e 'system chr(49)'",
    "ruby -e 'public_send(chr(49))'",
    "pwsh -OutputFormat Text -EncodedCommand Zg==",
    "python <<''FIRST <<'.SECOND'\nprint(1)\nFIRST\neval(chr(49))\n.SECOND",
    "python <<\\END|cat\neval(chr(49))\nEND",
  ]) assert.match(checkCommand(command, targets), /(?:interpreter code|interpreter heredoc|encoded commands)/, command);
  assert.match(checkCommand('fish -p profile -c "$CODE"', targets), /literal code/);
  assert.match(checkCommand("sh <<'FIRST' < other.sh\nFIRST", targets), /redirection/);
  assert.match(checkCommand("python -c 'subprocess.run((\"az\", \"keyvault\", \"secret\", \"show\", \"--vault-name\", \"kv-erpure-test\"))'", targets),
    /metadata-only/);
});

test('compound and launcher prefixes preserve structural checks', () => {
  for (const command of [
    'time -p { eval true; }', 'printf data | time -p { true; sh; }',
    'true && reader.v2() (sh); printf data | reader.v2',
    'printf data | pnpm -C sub --filter pkg exec sh', 'printf data | uv tool run sh',
    'printf data | poetry -C sub run sh', 'printf data | env -P /bin sh',
    'xargs -a operands sh', "watch 'eval true'",
    '"$A$B" arg', 'prefix"$A" arg', "prefix$'suffix' arg", './tool* arg', './tool{a,b} arg',
  ]) assert.ok(checkCommand(command, targets), command);
  assert.match(checkAzure('a\\\nz containerapp update -n app-erpure-test', targets), /az containerapp update/);
});

test('ordinary interpreter operands and data heredocs are allowed', () => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g5-'));
  try {
    writeFileSync(join(cwd, 'ordinary.sh'), 'cd "$(dirname "$0")"\nnode app.mjs\n');
    writeFileSync(join(cwd, 'notes.md'), 'git push --no-verify\n');
    writeFileSync(join(cwd, 'data.json'), ' '.repeat(270 * 1024));
    writeFileSync(join(cwd, 'tool.py'), 'print(1)\n');
    for (const path of ['dist', 'node_modules/typescript/bin', 'scripts']) mkdirSync(join(cwd, path), { recursive: true });
    for (const path of ['dist/bundle.js', 'node_modules/typescript/bin/tsc', 'package-lock.json', 'data.csv']) {
      writeFileSync(join(cwd, path), ' '.repeat(270 * 1024));
    }
    writeFileSync(join(cwd, 'README.md'), 'Documentation for --no-verify and .env');
    writeFileSync(join(cwd, 'scripts/lint-doc.sh'), 'printf "%s" "$1"\n');
    writeFileSync(join(cwd, 'scripts/parse.mjs'), 'console.log(1);\n');
    writeFileSync(join(cwd, 'scripts/analyze.py'), 'print(1)\n');
    for (const command of [
      'bash ordinary.sh notes.md', 'python tool.py data.json', 'python3 tool.py data.json',
      'node ./dist/bundle.js', 'node node_modules/typescript/bin/tsc',
      'node scripts/parse.mjs package-lock.json', 'python3 scripts/analyze.py data.csv',
      'bash scripts/lint-doc.sh README.md',
      'cd "$DIR" && node -e \'console.log(1)\'',
      'cd - && python3 -m pytest', 'cd "$DIR" && bun run test',
      'cd - && bash -c \'echo ok\'', 'cd "$DIR" && bash -c \'echo ok\'',
      'cd /tmp/--debug && az account show', 'printf "%s" --verbose && az account show',
      'bash -c \'git fetch origin && git log --reverse\'',
      'sh -c \'exec node app.js "a" "b"\'',
      'bash ordinary.sh "fetch failed via reverse proxy"',
      'node --test', 'node --test --test-reporter=spec',
      "awk '$1 == \"a\" || \"b\" == $2'", "awk '{ print ($1 || \"N/A\") }'",
      'case "$x" in a) echo 1;; *) echo 2;; esac',
      ...["cat <<'EOF' > notes.md", "cat >> CHANGELOG.md <<'EOF'",
        "git commit -F - <<'EOF'", "gh pr create --body-file - <<'EOF'",
        "cat <<'EOF'", "cat <<'EOF' | jq", "cat <<'EOF' | pbcopy", "cat <<'EOF' | grep item",
        "cat > config.json <<'EOF'", "cat > style.css <<'EOF'", "cat > Makefile <<'EOF'",
      ].map(header => header + '\n* item\n**Note:** a << b\n$VAR\n{"key": "value"}\nEOF\ngit status'),
      "cat > notes.md <<'EOF'\n* item\nEOF\ngit status",
      'git commit -m "$(cat <<\'EOF\'\na << b\n* item\nEOF\n)"',
    ]) assert.equal(checkCommand(command, targets, 0, { cwd, codex: true }), null, command);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('source checks allow variable argv helpers and regex methods through Write', () => {
  const file = fileURLToPath(import.meta.url);
  for (const content of [
    readFileSync(file, 'utf8'),
    'function runAz(args) { return execFileSync("az", args); }',
    'spawn("az", argv);',
    'cp.execFileSync("az", argv, options);',
    'pattern.exec("az keyvault secret show");',
    '/az/.exec("az keyvault secret show");',
  ]) assert.equal(checkHookInput({ tool_name: 'Write', tool_input: { file_path: 'helper.mjs', content } },
    targets, process.env.HOME + '/.codeden/wt/project'), null, content.slice(0, 160));
  assert.equal(checkCommand(`node --test "${file}"`, targets, 0, { cwd: process.cwd(), codex: true }), null);
});

test('input aliases, FIFOs and interpreter option values preserve stdin checks', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g5-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(spawnSync('mkfifo', [join(cwd, 'code.pipe')]).status, 0);
  const options = { cwd, codex: true };
  for (const path of ['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0', 'code.pipe']) {
    assert.match(checkCommand(`sh ${path}`, targets, 0, options), /unchecked input/);
    assert.match(checkCommand(`source ${path}`, targets, 0, options), /unchecked input/);
    assert.match(checkCommand(`sh < ${path}`, targets, 0, options), /unchecked input/);
  }
  for (const receiver of [
    'bash -euo pipefail', 'ruby -r library', 'php -d setting=value', 'osascript -l JavaScript',
    'pwsh -OutputFormat Text -Command -', 'node --max-old-space-size 4096',
    'npm exec -- sh', 'bun x sh',
  ]) {
    assert.match(checkCommand('printf data | ' + receiver, targets, 0, options), /unchecked input/);
    assert.match(checkCommand(receiver + ' < input', targets, 0, options), /unchecked input/);
  }
});

test('shell and launcher forms apply rules to the actual inline command', () => {
  const write = 'az containerapp update -n g5-fixture';
  for (const prefix of [
    'sh -c --', 'sh -c -e', 'bash -euo pipefail -c', 'fish --init-command true -c',
    'fish -C true -c', 'fish -c true -c', 'pwsh -OutputFormat Text -Command',
    'powershell -c', 'npx -c', 'npx --call', 'npm exec -c',
  ]) assert.match(checkCommand(`${prefix} '${write}'`, targets), /az containerapp update/, prefix);
  for (const prefix of ['npm exec --', 'bun x', 'pwsh -Command']) {
    assert.match(checkCommand(`${prefix} ${write}`, targets), /az containerapp update/, prefix);
  }
  for (const prefix of [
    'sh -c --', 'deno eval --ext=js', 'perl -e 1 -e', 'ruby -r library -e',
    'php -d setting=value -r', 'osascript -l JavaScript -e', 'pwsh -OutputFormat Text -Command',
  ]) assert.match(checkCommand(`${prefix} "$CODE"`, targets), /literal code/, prefix);
});

test('awk file and pipe forms inspect command execution', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g5-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const program = 'BEGIN { "echo sample" | getline }';
  writeFileSync(join(cwd, 'reader.awk'), program);
  writeFileSync(join(cwd, 'data.awk'), '{ print ($1 || "N/A") }');
  assert.equal(checkCommand(`awk '${program}'`, targets), null);
  assert.equal(checkCommand('awk -f reader.awk', targets, 0, { cwd }), null);
  assert.equal(checkCommand('awk -f data.awk', targets, 0, { cwd }), null);
});

test('a heredoc script is inspected when a later command executes it', () => {
  assert.match(checkCommand("cat <<'EOF' > run.sh\neval true\nEOF\nsh run.sh", targets), /eval executes/);
  assert.equal(checkCommand("cat <<'EOF' > notes.md\neval true\nEOF\ngit status", targets), null);
});

test('metadata exception retains the raw live debug and verbose check', () => {
  for (const flag of ['--debug', '--verbose']) {
    assert.equal(metadataOnlyQuery(`cd /tmp/${flag} && ${show} --query name`), false);
    assert.equal(metadataOnlyQuery(`printf '%s' '${flag}' && ${show} --query name`), false);
    assert.equal(metadataOnlyQuery(`${show} ${flag} --query name`), false);
  }
});

test('ordinary script arguments, pytest filters and shell code pass', () => {
  for (const command of [
    "python3 -m pytest -k 'fetch and base64'", "python3 -m pytest -k 'requests and decode'",
    'python3 -m pytest -k "fetch and reverse"', 'node --test --test-name-pattern "fetch base64"',
    'node --test --test-name-pattern "exec("', 'bun test -t "fetch base64"',
    'node scripts/tool.mjs "fetch failed via reverse proxy"', 'node scripts/cli.mjs "fetch in reverse"',
    'python3 scripts/tool.py "requests base64"',
    'bash -c \'node -e "console.log(1)" && git fetch origin && git log --reverse\'',
    "bash -c 'run() { git fetch origin && git log --reverse; }; run'",
    'bash -c \'rg "fetch(" --reverse\'',
  ]) assert.equal(checkCommand(command, targets, 0, { codex: true }), null, command);
});

test('quoted Markdown heredocs preserve surrounding shell syntax', () => {
  const prose = ["It's documentation with << and an unmatched )", '`node` and $(python)',
    '```sh', '* Example', 'sh', '```', 'EOF', ')'].join('\n');
  for (const command of [
    'git commit -m "$(cat <<\'EOF\'\n' + prose + '"',
    'gh pr create --body "$(cat <<\'EOF\'\n' + prose + '"',
    "MSG=$(cat <<'EOF'\n" + prose,
    "cat <<'EOF' > notes.md\nIt's documentation.\nEOF\necho \"$(printf ok)\"",
  ]) {
    assert.equal(checkCommand(command, targets), null, command);
    assert.equal(checkCommand(command, targets, 0, { codex: true }), null, command);
  }
  assert.match(checkCommand("cat <<'EOF' > notes.md\nIt's documentation.\nEOF\necho \"$(eval true)\"", targets), /eval executes/);
});

test('source checks allow az wrapper property accesses and argv builders', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g6-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const content of ['execFileSync("az", opts.args)', 'execFile("az", getArgs())', 'spawn("az", buildArgs())']) {
    for (const [tool_name, tool_input] of [
      ['Write', { content }], ['Edit', { new_string: content }],
      ['MultiEdit', { edits: [{ new_string: content }] }],
    ]) assert.equal(checkHookInput({ tool_name, tool_input: { file_path: 'helper.mjs', ...tool_input } },
      targets, process.env.HOME + '/.codeden/wt/project'), null, content);
    writeFileSync(join(cwd, 'helper.mjs'), content);
    assert.equal(checkCommand('node helper.mjs', targets, 0, { cwd }), null, content);
  }
});

test('empty quoted heredoc delimiters finish within a bounded time', () => {
  const code = `import { checkCommand } from ${JSON.stringify(new URL('./codeden-guard.mjs', import.meta.url).href)};
    for (const command of JSON.parse(process.argv[1])) {
      if (checkCommand(command)) process.exit(1);
    }`;
  const commands = ["cat <<''\n\n", 'cat <<""\n\n', "cat <<''\nbody\n\necho ok"];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(commands)],
    { encoding: 'utf8', timeout: 2500 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('literal script writes and direct execution receive script checks', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g6-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'tool'), '#!/bin/sh\neval true\n');
  const options = { cwd };
  for (const command of [
    "echo 'eval true' > run.sh && sh run.sh",
    "printf '%s\\n' 'eval true' > run.sh && bash run.sh",
    "printf 'eval true\\n' > run.sh && ./run.sh",
    "cat <<'EOF' > run.sh\neval true\nEOF\nchmod +x run.sh && ./run.sh",
    './tool', `${cwd}/tool`,
  ]) assert.match(checkCommand(command, targets, 0, options), /eval executes/, command);
  assert.equal(checkCommand("echo 'echo ok' > run.sh && ./run.sh", targets, 0, options), null);
});

test('numeric descriptor operands, bundled shell options and gawk forms are checked', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g6-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const program = 'BEGIN { "echo sample" |& getline }';
  writeFileSync(join(cwd, 'reader.awk'), program);
  for (const command of ['sh /dev/fd/3', 'source /proc/self/fd/27', 'node /proc/self/fd/18',
    'bash /dev/fd/3 3< input.sh', 'sh /dev/fd/3 3<<< "echo sample"', 'source /dev/fd/3 3< input.sh']) {
    assert.match(checkCommand(command, targets), /unchecked input/, command);
  }
  for (const prefix of ['sh -c -', 'bash -co pipefail', 'bash -cO extglob', 'bash -oe pipefail -c']) {
    assert.match(checkCommand(`${prefix} 'eval true'`, targets), /eval executes/, prefix);
    assert.equal(checkCommand(`${prefix} 'echo ok'`, targets), null, prefix);
  }
  for (const command of [`gawk '${program}'`, 'gawk \'BEGIN { print "" |& "echo sample" }\'',
    'gawk --file reader.awk', 'gawk --file=reader.awk', 'gawk -freader.awk']) {
    assert.equal(checkCommand(command, targets, 0, { cwd }), null, command);
  }
});

test('command lookup allows executable names without running them', () => {
  for (const flag of ['-v', '-V', '-pV']) {
    for (const program of ['az', 'node', 'python3', 'bash', 'sh']) {
      const command = `command ${flag} ${program} >/dev/null`;
      assert.equal(checkCommand(command, targets, 0, { codex: true }), null, command);
    }
  }
  assert.match(checkCommand("command bash -c 'eval true'", targets), /eval executes/);
});

test('formatted source inspects multiline literal Azure arguments', () => {
  const project = process.env.HOME + '/.codeden/wt/project';
  const az = '"az"';
  for (const [file_path, content] of [
    ['helper.js', `execFileSync(${az}, [\n  "account",\n  "show",\n])`],
    ['helper.ts', `execFileSync(${az},\n  ["account", "show"])`],
    ['helper.py', `subprocess.run([\n  ${az},\n  "account", "show",\n])`],
    ['helper.py', `subprocess.run([${az},\n "keyvault", "secret", "show",\n "--vault-name", "kv-erpure-x", "-n", "s", "--query", "name",\n])`],
  ]) {
    const inspect = text => checkHookInput({ tool_name: 'Write', tool_input: { file_path, content: text } }, targets, project);
    assert.equal(inspect(content), null, content);
    assert.ok(inspect(content.includes('keyvault') ? content.replace('"name",', '"value",') :
      content.replace('"account"', '"group"').replace('"show"', '"delete"')), content);
  }
  const content = `execFileSync(${az}, [\n  "account", "show"\n].concat(extra))`;
  assert.ok(checkHookInput({ tool_name: 'Write', tool_input: { file_path: 'helper.js', content } }, targets, project));
});

test('path-qualified Azure CLI uses the same command checks as bare az', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g7-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'az'), '#!/bin/bash\nexec "/opt/homebrew/Cellar/azure-cli/2.0/libexec/bin/python" -Im azure.cli "$@"\n');
  for (const [program, args] of [['/opt/homebrew/bin/az', 'group list'],
    ['/usr/local/bin/az', 'account show'], ['./az', 'account show']]) {
    assert.equal(checkCommand(`${program} ${args}`, targets, 0, { cwd }), null, program);
    assert.equal(checkCommand(`${program} group delete`, targets, 0, { cwd }), checkCommand('az group delete', targets));
  }
  writeFileSync(join(cwd, 'az'), '#!/bin/sh\neval true\n');
  assert.match(checkCommand('./az account show', targets, 0, { cwd }), /eval executes/);
});

test('bundled uppercase shell flags preserve command and stdin operands', () => {
  for (const prefix of ['bash -Ec', 'bash -Eo pipefail -c', 'bash -EcO extglob', 'bash -c -Eo pipefail']) {
    assert.match(checkCommand(`${prefix} 'eval true'`, targets), /eval executes/, prefix);
    assert.equal(checkCommand(`${prefix} 'echo ok'`, targets), null, prefix);
  }
  for (const flags of ['-Es', '-Eo pipefail']) {
    assert.ok(checkCommand(`printf '%s' 'eval true' | bash ${flags}`, targets), flags);
  }
});

test('script write tracking covers tee and redirect operators', () => {
  for (const write of [
    "printf '%s' 'eval true' | tee candidate.sh",
    "printf '%s' 'eval true' | tee -a candidate.sh",
    ...['>|', '&>', '&>>', '1>', '>>'].flatMap(op => [
      `echo 'eval true' ${op} candidate.sh`, `sed '' ${op}candidate.sh`,
    ]),
  ]) {
    assert.match(checkCommand(`${write} && sh candidate.sh`, targets), /eval executes|written script could not be inspected/, write);
    assert.equal(checkCommand(write, targets), null, write);
  }
});

test('heredoc apostrophes preserve expansion and trailing command inspection', () => {
  for (const command of [
    "cat <<EOF\nIt's $(eval true)\nEOF",
    "cat <<EOF\nIt's `eval true`\nEOF",
    "cat <<EOF\nIt's text\nEOF\necho \"$(eval true)\"",
    "echo \"$(cat <<EOF\nIt's ) # $(eval true)\nEOF\n)\"",
    "cat <<EOF <<'LITERAL'\nIt's text\nEOF\n'$(ignored)\nLITERAL\necho \"$(eval true)\"",
  ]) assert.match(checkCommand(command, targets), /eval executes/, command);
  assert.equal(checkCommand("cat <<EOF <<'LITERAL'\nIt's text\nEOF\n$(eval true)\nLITERAL", targets), null);
  for (const delimiter of ['EOF', "'EOF'"]) {
    const prefix = `cat <<${delimiter} > notes.txt\nIt's text\nEOF\n`;
    for (const [command, reason] of [
      ['az group delete', /names no resource/],
      ['node running-ref.mjs check --include-prod', /probes production/],
      ['agy -p sample', /outside the review wrapper/],
    ]) assert.match(checkCommand(prefix + command, targets), reason, command);
  }
});

test('G8 allows checked literal execution in commands and scripts', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g8-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const commands = [
    "find . -type f -name '*.ts' -exec grep -l TODO {} +",
    ...['exec', 'execdir', 'ok', 'okdir'].map(action => `find . -${action} grep -l TODO {} \\;`),
    'git diff --name-only | xargs node scripts/check.mjs',
    "find . -name '*.py' | xargs python3 -m py_compile",
    'git diff --name-only | xargs -n1 bash scripts/lint-doc.sh',
    "printf '%s\\n' file | xargs sh -c 'echo \"$1\"' _",
    "printf '%s\\n' file | xargs node -e 'console.log(process.argv[1])'",
    'awk \'{print $2 | "sort -u"}\'',
    'awk \'BEGIN{"date" | getline d}\'',
    'awk \'BEGIN{system("date")}\'',
    'awk \'/foo|bar/ {print}\'',
    '# no secrets here\nnode "$ROOT/scripts/x.mjs"\nbash "$DIR/build.sh"\nsource "$DIR/common.sh"\n"$PYTHON" tool.py\nexec "$@"\n',
    'cp config/appsettings.Development.json config/appsettings.json\nbash "$DIR/build.sh"',
  ];
  const project = process.env.HOME + '/.codeden/wt/project';
  const write = (file_path, content) => checkHookInput({ tool_name: 'Write', tool_input: { file_path, content } },
    targets, project);
  for (const command of commands) {
    assert.equal(checkCommand(command, targets, 0, { cwd, scriptContent: command.includes('"$DIR/') }), null, command);
    assert.equal(write('helper.sh', command), null, command);
  }

  for (const [file, source] of [
    ['helper.py', 'subprocess.run(["az", *args], check=True)'],
    ['helper.py', 'subprocess.run(["az", "group", "list", *extra])'],
    ['helper.py', 'subprocess.run(["az", "keyvault", "secret", "list", *extra])'],
    ['helper.py', 'subprocess.run(["az"] + args)'],
    ['helper.py', 'subprocess.run(\n  ["az", *args],\n  check=True,\n)'],
    ['helper.mjs', 'execFileSync("az", [...args])'],
    ['helper.mjs', 'execFileSync("az", ["group", "list", ...extra])'],
    ['helper.mjs', 'execFileSync(\n  "az",\n  args,\n)'],
  ]) {
    assert.equal(write(file, source), null, source);
    writeFileSync(join(cwd, file), source);
    assert.equal(checkCommand(`${file.endsWith('.py') ? 'python3' : 'node'} ${file}`, targets, 0, { cwd }), null, source);
  }
});

test('G8 still checks effective commands and fail-closes unknown script writes', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g8-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const prd = 'az group delete --name rg-erpure-prd';
  writeFileSync(join(cwd, 'candidate.sh'), 'echo harmless\n');
  writeFileSync(join(cwd, 'unsafe.sh'), 'eval true\n');
  assert.equal(checkCommand("printf '%s\\n' 'echo safe' > candidate.sh && sh candidate.sh", targets, 0, { cwd }), null);
  for (const command of [
    'find . -exec "$program" {} +',
    'find . -exec sh -c "{}" \\;',
    `find . -exec ${prd} {} +`,
    'printf data | xargs sh -c',
    'printf data | xargs sh unsafe.sh',
    "printf data | xargs sh -c 'eval true' _",
    'printf data | xargs -I{} sh -c "{}"',
    'printf data | xargs node',
    'printf data | xargs python -m "$module"',
    'awk \'{print $2 | "echo " $1}\'',
    'awk \'BEGIN{"echo " command | getline d}\'',
    'awk \'BEGIN{system("echo " command)}\'',
    'awk \'BEGIN{system("eval true")}\'',
    'bash <<\'EOF\'\neval true\nEOF',
    ...['gtimeout 1', 'gnice -n 1', 'gstdbuf -oL', 'genv', 'gxargs', 'mise exec --', 'direnv exec .',
      'op run --', 'bundle exec', 'yarn exec', 'yarn', 'setsid', 'unbuffer', 'chronic', "sandbox-exec -p 'profile'",
      'sudo -Eu user', 'sudo -iu user', '/opt/homebrew/bin/unknown-launcher'].map(prefix =>
      `${prefix.startsWith('/') || prefix.startsWith('sudo') ? prefix : '/opt/homebrew/bin/' + prefix} ${prd}`),
    "/opt/homebrew/bin/gtimeout 1 bash -c 'eval true'",
    ...['2>', '7>', '>&', '3<>', '2>>', '2>|'].flatMap(op =>
      [`processor ${op}candidate.sh && sh candidate.sh`, `processor ${op} candidate.sh && ./candidate.sh`]),
    'processor 2>candidate.sh 1>&2 && source candidate.sh',
    'processor >candidate.sh && sh candidate.sh',
    'dd of=candidate.sh && ./candidate.sh',
    'echo safe >candidate.sh && dd of=candidate.sh && ./candidate.sh',
    "cp /dev/stdin candidate.sh <<'EOF'\neval true\nEOF\nsource candidate.sh",
    'install /dev/stdin candidate.sh && bash candidate.sh',
    'sponge candidate.sh && bash candidate.sh',
    'sort -o candidate.sh && bash candidate.sh',
    'curl -o candidate.sh && bash candidate.sh',
  ]) assert.ok(checkCommand(command, targets, 0, { cwd }), command);

  const hook = fileURLToPath(new URL('./codeden-guard.mjs', import.meta.url));
  for (const command of [
    "printf '%s' 'keyvault secret show --vault-name kv-erpure-x -n example' | xargs az",
    "echo show --vault-name kv-erpure-x -n example | xargs az keyvault secret",
    "echo example | env /opt/homebrew/bin/gxargs az keyvault secret show --vault-name kv-erpure-x -n",
  ]) {
    assert.ok(checkCommand(command, targets, 0, { cwd }), command);
    const result = spawnSync(process.execPath, [hook, 'codex'], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
    assert.equal(result.status, 2, command + '\n' + result.stderr);
  }
});

test('G9 R1 preserves a live denial before structural size checks', t => {
  const hook = fileURLToPath(new URL('./codeden-guard.mjs', import.meta.url));
  const cwd = join(process.cwd(), '.guard-g9', 'wt', 'project');
  const argument = '{'.repeat(300 * 1024);
  for (const mode of [[], ['codex']]) {
    for (const [command, reason] of [
      ['node running-ref.mjs check --run r --include-prod ' + argument, /probes production/],
      ['echo ' + argument, /too large for structural analysis/],
    ]) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [hook, ...mode], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
        env: { ...process.env, CODEDEN_HOME: join(cwd, '../..') },
        encoding: 'utf8',
        timeout: 2000,
      });
      const elapsed = performance.now() - start;
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, reason);
      assert.ok(elapsed < 2000, `${elapsed.toFixed(1)} ms`);
      t.diagnostic(`${mode[0] ?? 'Claude'} ${reason.source}: ${elapsed.toFixed(1)} ms`);
    }
  }
});

test('G9 F1 treats later az words as data without a known command group', () => {
  for (const command of [
    'cd infra/az',
    'for t in az jq; do command -v "$t" >/dev/null || exit 1; done',
    './scripts/report.sh AZ',
  ]) assert.equal(checkCommand(command, targets, 0, { cwd: process.cwd() }), null, command);
});

test('G9 review 2 F2 checks relative operands from the hook cwd after a dynamic cd', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g9-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const command = 'cd "$(git rev-parse --show-toplevel)" && node scripts/check.mjs';
  mkdirSync(join(cwd, 'scripts'));
  for (const codex of [false, true]) {
    assert.equal(checkCommand(command, targets, 0, { cwd, codex }), null);
  }
  const source = ['execFileSync', '("az", ["group", "delete", "--name", "rg-erpure-prd"])'].join('');
  writeFileSync(join(cwd, 'scripts/check.mjs'), source);
  assert.match(checkCommand(command, targets, 0, { cwd }), /az group delete/);
});

test('G9 review 3 F2 allows source argv that captures an ARM token', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g9-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [file, command, content] of [
    ['arm.py', 'python3 arm.py', 'subprocess.check_output(["az", "account", "get-access-token", "--resource", "https://management.azure.com"])'],
    ['arm.mjs', 'node arm.mjs', 'execFileSync("az", ["account", "get-access-token", "--resource", "https://management.azure.com"])'],
  ]) {
    assert.equal(checkHookInput({ tool_name: 'Write', tool_input: { file_path: file, content } },
      targets, process.env.HOME + '/.codeden/wt/project'), null);
    writeFileSync(join(cwd, file), content);
    assert.equal(checkCommand(command, targets, 0, { cwd }), null);
  }
});

test('G9 F3 checks quoted commit and PR heredoc text for keychain operations', () => {
  for (const header of ["git commit -F -", "gh pr create --body-file -", "cat <<'EOF' | gh pr create --body-file -"]) {
    const command = (header.includes('<<') ? header : header + " <<'EOF'") +
      '\nDeny find-generic-password and dump-keychain reads.\nEOF';
    assert.match(checkCommand(command, targets), /keychain/, command);
  }
});

test('G9 F4 allows building and running a new output', t => {
  const cwd = mkdtempSync(join(process.cwd(), '.guard-g9-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const command of [
    'go build -o bin/tool ./cmd/tool && ./bin/tool --version',
    'gcc -o hello hello.c && ./hello',
    'esbuild src/cli.ts --bundle --outfile=dist/cli.js && node dist/cli.js',
    'processor --output=missing.sh && bash missing.sh',
  ]) assert.equal(checkCommand(command, targets, 0, { cwd }), null, command);
});

test('G9 F5 refuses a migration plan with a variable script path', () => {
  const command = '~/.trioharness/db-ops/dbops migrate erpure ERPureAI_QA --script "$WT/sql/init.sql" --plan';
  assert.match(checkCommand(command, targets, 0, { cwd: process.cwd() }), /DB migration requires/);
});

test('G9 F6 allows syntax-only checks of find and xargs operands', () => {
  for (const command of [
    "find . -name '*.sh' -exec bash -n {} \\;",
    "find . -name '*.sh' -exec sh -n {} \\;",
    "find . -name '*.mjs' -exec node --check {} \\;",
    "git ls-files '*.sh' | xargs -n1 bash -n",
    "git ls-files '*.sh' | xargs -I{} bash -n {}",
  ]) assert.equal(checkCommand(command, targets), null, command);
  for (const flag of ['+n', '+o noexec']) {
    assert.match(checkCommand(`find . -exec bash -n ${flag} {} \\;`, targets), /literal script path/);
  }
});
