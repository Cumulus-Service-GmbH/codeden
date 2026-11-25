import { type ForkHandoff, runForkWorker } from "./fork-worker";

const handoff = JSON.parse(process.argv[2] ?? "null") as ForkHandoff;
process.once("message", (message) => {
  if (message !== "apply") return;
  void runForkWorker(handoff).then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
// The old app never approved handoff if its IPC connection closes before the apply message.
process.once("disconnect", () => process.removeAllListeners("message"));
