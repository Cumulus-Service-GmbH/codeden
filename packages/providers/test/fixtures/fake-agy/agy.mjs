// A scripted stand-in for the Antigravity CLI's ACP server (`agy acp --process-per-session`,
// protocol version 1). It answers `initialize` and `session/new` with the replies a real
// agy 1.5.13 gave (`capture.json`, captured over stdio without any prompt turn). No model is
// ever called.
//   agy.mjs --version   prints FAKE_AGY_VERSION (default 1.5.13)
//   agy.mjs acp --process-per-session   serves ACP on stdio; FAKE_AGY_NO_ACP=1 fails
// Like agy: sessions report `modes`, `models` and config options (`model`, `thought_level`,
// `mode`); `session/set_config_option` answers with every option.
// FAKE_AGY_AUTH=missing: `session/new` fails as signed out. FAKE_AGY_LOG: every message the
// client sends, one JSON line each. FAKE_AGY_REJECT_FILE: while that file exists,
// `session/set_config_option` fails. FAKE_AGY_REPLY: the text each `session/prompt` streams.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
const record = (entry) => {
  if (env.FAKE_AGY_LOG) appendFileSync(env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`);
};

if (args[0] === "--version") {
  console.log(env.FAKE_AGY_VERSION ?? "1.5.13");
  process.exit(0);
}
if (args[0] !== "acp" || !args.includes("--process-per-session") || env.FAKE_AGY_NO_ACP === "1") {
  console.error(`unexpected arguments: ${args.join(" ")}`);
  process.exit(1);
}

const capture = JSON.parse(readFileSync(new URL("./capture.json", import.meta.url), "utf8"));
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const setup = structuredClone(capture.sessionNew);
const session = setup.sessionId;

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) return;
  record({ method: msg.method, params: msg.params });
  switch (msg.method) {
    case "initialize":
      return send({ id: msg.id, result: capture.initialize });
    case "authenticate":
      // CodeDen must never send it: `agy acp` reuses the login of an interactive `agy`.
      return send({ id: msg.id, error: { code: -32000, message: "authenticate is not expected" } });
    case "session/new":
      if (env.FAKE_AGY_AUTH === "missing") {
        return send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
      }
      return send({ id: msg.id, result: setup });
    case "session/load":
      return send({ id: msg.id, result: { ...setup, sessionId: undefined } });
    case "session/set_config_option": {
      const option = setup.configOptions.find((o) => o.id === msg.params.configId);
      const refused = env.FAKE_AGY_REJECT_FILE && existsSync(env.FAKE_AGY_REJECT_FILE);
      if (refused || !option || !option.options.some((o) => o.value === msg.params.value)) {
        return send({ id: msg.id, error: { code: -32602, message: "invalid config value" } });
      }
      option.currentValue = msg.params.value;
      return send({ id: msg.id, result: { configOptions: setup.configOptions } });
    }
    case "session/prompt":
      send({
        method: "session/update",
        params: {
          sessionId: session,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: env.FAKE_AGY_REPLY ?? "Done." },
          },
        },
      });
      return send({ id: msg.id, result: { stopReason: "end_turn" } });
    case "session/cancel":
      return;
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
