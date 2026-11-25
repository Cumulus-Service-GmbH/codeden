const pairs = ['issuer', 'environment', 'storageAccount'];

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function format(mode, pair, input) {
  if (mode === 'names' && Array.isArray(input) && input.every(row =>
    hasKeys(row, ['name', 'set', 'on']) &&
    typeof row.name === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(row.name) &&
    typeof row.set === 'boolean' && typeof row.on === 'boolean')) {
    return JSON.stringify(input.map(row => row.name));
  }
  if (mode === 'equality' && hasKeys(input, pairs) && pairs.every(key => {
    const row = input[key];
    return (hasKeys(row, ['equal']) && typeof row.equal === 'boolean') ||
      (hasKeys(row, ['equal', 'reason']) && row.equal === null &&
        ['missing', 'secretref'].includes(row.reason));
  }) && typeof input[pair].equal === 'boolean') {
    return input[pair].equal ? 'match' : 'no-match';
  }
  throw new Error();
}

try {
  const args = process.argv.slice(2);
  const [mode, pair] = args;
  if (!(mode === 'names' && args.length === 1) &&
      !(mode === 'equality' && args.length === 2 && pairs.includes(pair))) throw new Error();

  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  process.stdout.write(format(mode, pair, input) + '\n');
} catch {
  process.stderr.write('readback denied\n');
  process.exitCode = 2;
}
