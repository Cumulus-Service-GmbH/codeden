import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";

// The kernel arbitrates these loopback slots across users and checkouts, and releases them on exit.
const TEST_PORTS = [46178, 46179];

export async function tryTestSlot(ports = TEST_PORTS) {
  for (const port of ports) {
    const slot = createServer((socket) => socket.destroy());
    const acquired = await new Promise((resolve, reject) => {
      slot.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      slot.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });
    if (acquired) return slot;
  }
  return null;
}

export async function waitForTestSlot() {
  let waiting = false;
  while (true) {
    const slot = await tryTestSlot();
    if (slot) {
      slot.unref();
      return;
    }
    if (!waiting) {
      console.log("Two full-suite test slots are busy. Waiting for a slot.");
      waiting = true;
    }
    await setTimeout(1_000);
  }
}
