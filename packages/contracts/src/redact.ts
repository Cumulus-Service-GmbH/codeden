/**
 * Secret redaction shared by everything that shows transcript text outside the transcript: the
 * session's Markdown export (§13), which people paste into issues and chats, and the pixel
 * scene's activity bubbles and the factory's lessons. Pure: text in, text and a count out.
 *
 * It hides private key blocks, credentials in URLs, `Authorization` headers and bearer tokens,
 * well-known token formats (GitHub, OpenAI and Anthropic, Stripe, Slack, GitLab, npm, AWS access
 * keys, Google, Hugging Face, CodeDen's own MCP and remote-access tokens), JSON Web Tokens,
 * `KEY=value` pairs and `--flag value` options whose name says secret (TOKEN, SECRET, PASSWORD,
 * API_KEY…), and exact values the caller knows are secret (CodeDen's install token). Ordinary
 * words and hashes such as git SHAs are left alone unless `opaque` is set.
 */

/** What a hidden value reads by default. */
export const REDACTED = "[redacted]";

export interface RedactOptions {
  /** What a hidden value becomes; default `[redacted]`. */
  mask?: string;
  /**
   * Exact values to hide wherever they appear, such as CodeDen's install token. Values shorter
   * than 12 characters are ignored, so a short one can't blank out ordinary words.
   */
  known?: readonly string[];
  /**
   * Also hide any long opaque string (32 or more letters and digits without a break). Hides
   * hashes such as git SHAs too: meant for glimpses (the pixel scene), not for documents.
   */
  opaque?: boolean;
}

export interface Redaction {
  text: string;
  /** How many values were hidden. */
  count: number;
}

/** Rewrites one match: the replacement, or null to keep it as it is. */
type Rewrite = (mask: string, match: string, groups: string[]) => string | null;

interface Rule {
  pattern: RegExp;
  rewrite: Rewrite;
}

const whole: Rewrite = (mask) => mask;

/** Words that make a key name a secret: `GITHUB_TOKEN`, `clientSecret`, `DB_PASSWORD`. */
const SECRET_WORDS = new Set(["token", "secret", "password", "passwd", "passphrase", "pass"]);
/** Words that make `key` a secret right after them: `API_KEY`, `privateKey`. */
const KEY_KINDS = new Set([
  "api",
  "access",
  "secret",
  "private",
  "signing",
  "encryption",
  "master",
]);
/** A key ending in one of these names something about a secret, not the secret itself. */
const NOT_SECRET_TAIL = new Set([
  "url",
  "uri",
  "endpoint",
  "host",
  "domain",
  "path",
  "file",
  "dir",
  "name",
  "id",
  "type",
  "kind",
  "count",
  "length",
  "size",
  "limit",
  "budget",
  "ttl",
  "expiry",
  "expires",
  "expiration",
  "lifetime",
  "header",
  "prefix",
  "env",
  "var",
  "field",
  "version",
  "mode",
  "format",
  "provider",
  "method",
  "policy",
]);

/** Whether a key or option name says its value is a secret. */
function secretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = words.at(-1);
  if (!last || NOT_SECRET_TAIL.has(last)) return false;
  return words.some(
    (w, i) =>
      SECRET_WORDS.has(w) || w === "apikey" || (w === "key" && KEY_KINDS.has(words[i - 1] ?? "")),
  );
}

/**
 * Whether a value given to a secret-named key is worth hiding: not empty, not a reference
 * (`$TOKEN`, `%TOKEN%`, `${{ secrets.X }}`, `<your key>`), not a placeholder, a call or a literal
 * like `true`. Unless `loose`, an unquoted value (code, prose) must also look random, with a
 * digit, so `token: string` or `Password: use eight characters` stay as they are.
 */
function hideable(raw: string, mask: string, loose: boolean): boolean {
  const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.endsWith(raw[0]);
  const value = quoted ? raw.slice(1, -1) : raw;
  if (!value.trim() || value.includes(mask)) return false;
  // A reference, an array or call, a value already hidden (`[redacted]`), or a placeholder.
  if (/^[$%<{[(]/.test(value) || /^[*xX.•…_-]+$/.test(value)) return false;
  if (/^(?:true|false|null|undefined|none|nil)$/i.test(value)) return false;
  if (quoted) return true;
  if (/[()]/.test(value)) return false;
  return loose || (/\d/.test(value) && value.length >= 6);
}

/** `KEY=value`, `key: "value"`, `"api_key": "…"`: a key, a separator, then a value. */
const keyValue: Rewrite = (mask, match, [quote = "", key = "", sep = "", value = ""]) => {
  if (!secretName(key)) return null;
  // An assignment in env, shell, ini or URL style (`DB_PASSWORD=…`, `_authToken=…`, `?token=…`)
  // hides whatever it is given.
  const loose = sep === "=" || (/^[A-Z][A-Z0-9_]*$/.test(key) && sep.includes("="));
  if (!hideable(value, mask, loose)) return null;
  return `${match.slice(0, quote.length * 2 + key.length + sep.length)}${mask}`;
};

/** `--token abc`, `--password=hunter2`. */
const option: Rewrite = (mask, _match, [flag = "", sep = "", value = ""]) =>
  !value.startsWith("-") && hideable(value, mask, true) ? `${flag}${sep}${mask}` : null;

/** `Authorization: Bearer …`: any value after a scheme; without one, only a value with a digit. */
const authorization: Rewrite = (mask, _match, [label = "", scheme = "", value = ""]) =>
  scheme || /\d/.test(value) ? `${label}${mask}` : null;

/** `Bearer …` or `Basic …` outside a header: only a value that looks random. */
const bearer: Rewrite = (mask, _match, [label = "", value = ""]) =>
  /\d/.test(value) ? `${label}${mask}` : null;

const TOKEN_VALUE = "[A-Za-z0-9._~+/=-]{8,}";

const RULES: readonly Rule[] = [
  // PEM private keys, through their END line (or their base64 lines when it was cut off).
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|(?:\r?\n[ \t>]*[A-Za-z0-9+/=]+[ \t]*)*)/g,
    rewrite: whole,
  },
  // https://user:password@host
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    rewrite: (mask, _match, [scheme = ""]) => `${scheme}${mask}@`,
  },
  // Authorization: Bearer <token>, "authorization": "token <token>"
  {
    pattern: new RegExp(
      `\\b(authorization["']?[ \\t]*[:=][ \\t]*["']?((?:bearer|basic|token|digest|bot)[ \\t]+)?)(${TOKEN_VALUE})`,
      "gi",
    ),
    rewrite: authorization,
  },
  // Bearer <token> elsewhere (`curl --oauth2-bearer`, prose).
  { pattern: new RegExp(`\\b((?:bearer|basic)[ \\t]+)(${TOKEN_VALUE})`, "gi"), rewrite: bearer },
  // Well-known token formats.
  {
    pattern: new RegExp(
      [
        "gh[pousr]_[A-Za-z0-9]{20,}",
        "github_pat_[A-Za-z0-9_]{20,}",
        "sk-(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{20,}",
        "[sr]k_(?:live|test)_[A-Za-z0-9]{16,}",
        "xox[abeoprs]-[A-Za-z0-9-]{10,}",
        "glpat-[A-Za-z0-9_-]{16,}",
        "npm_[A-Za-z0-9]{20,}",
        "(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
        "AIza[0-9A-Za-z_-]{30,}",
        "hf_[A-Za-z0-9]{30,}",
        "cd[ms]_[A-Za-z0-9_-]{32,}",
      ]
        .map((p) => `\\b${p}`)
        .join("|"),
      "g",
    ),
    rewrite: whole,
  },
  // JSON Web Tokens.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, rewrite: whole },
  // KEY=value, key: "value", "api_key": "value"
  {
    pattern:
      /(?<![\w$.])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1([ \t]*[=:][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"'`,;&)\]}]+)/g,
    rewrite: keyValue,
  },
  // --token abc, --password=hunter2
  {
    pattern:
      /(?<![\w-])(--?(?:api-?key|access-?key|secret|client-?secret|token|auth-?token|password|passwd|pass))(=|[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'`,;]+)/gi,
    rewrite: option,
  },
];

/** Anything long and opaque with letters and digits; a slash or a dot breaks it (paths). */
const OPAQUE: Rule = {
  pattern: /(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}/g,
  rewrite: whole,
};

function knownRule(known: readonly string[]): Rule | null {
  const values = [...new Set(known.filter((v) => v.length >= 12))].sort(
    (a, b) => b.length - a.length,
  );
  if (values.length === 0) return null;
  const escaped = values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { pattern: new RegExp(escaped.join("|"), "g"), rewrite: whole };
}

/**
 * One rule over `text`. A match the rule keeps is searched again from its next character, so a
 * key that isn't secret (`https:`) can't hide a secret one inside its value (`?token=…`).
 */
function applyRule(text: string, { pattern, rewrite }: Rule, mask: string): Redaction {
  let out = "";
  let last = 0;
  let count = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const replaced = rewrite(
      mask,
      m[0],
      m.slice(1).map((g) => g ?? ""),
    );
    if (replaced === null) {
      pattern.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index) + replaced;
    last = m.index + m[0].length;
    pattern.lastIndex = Math.max(last, m.index + 1);
    count++;
  }
  return { text: out + text.slice(last), count };
}

/**
 * `text` with every secret-looking value replaced by the mask (`[redacted]`), and how many were
 * replaced. Running it again on its own output changes nothing.
 */
export function redactAndCount(text: string, options: RedactOptions = {}): Redaction {
  const mask = options.mask ?? REDACTED;
  const known = knownRule(options.known ?? []);
  const rules = [...(known ? [known] : []), ...RULES, ...(options.opaque ? [OPAQUE] : [])];
  let result: Redaction = { text, count: 0 };
  for (const rule of rules) {
    const next = applyRule(result.text, rule, mask);
    result = { text: next.text, count: result.count + next.count };
  }
  return result;
}

/**
 * Short text shown or kept outside the transcript (the pixel scene's activity bubbles, the
 * factory's lessons) with every secret-looking part replaced by `***`. It errs on the side of
 * hiding: any long opaque string, a hash in a message included, is masked too.
 */
export function redactSecrets(text: string): string {
  return redactAndCount(text, { mask: "***", opaque: true }).text;
}
