import { fileURLToPath } from "node:url";
import { waitForTestSlot } from "./test-slots.mjs";

await waitForTestSlot();
// Run the CLI in this process so the kernel holds the slot for the entire suite.
const cli = new URL("../node_modules/vitest/vitest.mjs", import.meta.url);
process.argv.splice(1, 1, fileURLToPath(cli), "run");
await import(cli.href);
