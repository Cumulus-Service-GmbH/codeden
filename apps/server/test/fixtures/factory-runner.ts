import { FakeProvider } from "@codeden/providers";
import { startRunner } from "../../../runner/src/runner";

const builder = new FakeProvider();
const reviewer = new FakeProvider();
Object.defineProperty(reviewer, "id", { value: "fake-review" });
const capabilities = builder.capabilities();
builder.capabilities = () => ({ ...capabilities, modelVendor: "anthropic" });
reviewer.capabilities = () => ({ ...capabilities, modelVendor: "openai" });

const home = process.argv[process.argv.indexOf("--home") + 1];
if (!home) throw new Error("Missing runner home");
const runner = await startRunner({
  home,
  adapters: [builder, reviewer],
  onShutdown: () => process.exit(0),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void runner.close().then(() => process.exit(0)));
}
