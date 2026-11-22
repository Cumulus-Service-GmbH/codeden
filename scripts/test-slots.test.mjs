import { createServer } from "node:net";
import { expect, it } from "vitest";
import { tryTestSlot } from "./test-slots.mjs";

it("admits two suites, excludes a third, and reuses a released slot", async () => {
  const firstPort = await tryTestSlot([0]);
  const secondPort = await tryTestSlot([0]);
  const ports = [firstPort.address().port, secondPort.address().port];
  await Promise.all([close(firstPort), close(secondPort)]);

  const first = await tryTestSlot(ports);
  const second = await tryTestSlot(ports);
  let replacement;
  try {
    expect(first).toBeInstanceOf(createServer().constructor);
    expect(second).toBeInstanceOf(createServer().constructor);
    expect(await tryTestSlot(ports)).toBeNull();
    await close(first);
    replacement = await tryTestSlot(ports);
    expect(replacement.address().port).toBe(ports[0]);
  } finally {
    await Promise.all([first, second, replacement].filter((slot) => slot?.listening).map(close));
  }
});

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
