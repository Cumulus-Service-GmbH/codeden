import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";

// The kernel arbitrates these loopback slots across users and checkouts, and releases them on exit.
const TEST_PORTS = [26178, 26179];

export async function tryTestSlot(ports = TEST_PORTS) {
  for (const port of ports) {
    const slot = createServer((socket) => socket.destroy());
    const acquired = await new Promise((resolve, reject) => {
      slot.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else
          reject(
            new Error(`Could not bind test slot on port ${port}: ${error.code}`, { cause: error }),
          );
      });
      slot.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });
    if (acquired) return slot;
  }
  return null;
}

export async function waitForTestSlot({ ports = TEST_PORTS, timeoutMs = 20 * 60_000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  let waiting = false;
  while (true) {
    const slot = await tryTestSlot(ports);
    if (slot) {
      slot.unref();
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error(`Timed out waiting for a test slot on ports ${ports.join(", ")}`);
    if (!waiting) {
      console.log("Two full-suite test slots are busy. Waiting for a slot.");
      waiting = true;
    }
    await setTimeout(Math.min(1_000, remaining));
  }
}
