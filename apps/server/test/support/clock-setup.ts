import { runClockFrom, todayAt } from "./test-clock";

/**
 * Setup file of the server suites (`apps/server/vitest.config.ts`). With `CODEDEN_TEST_CLOCK=hh:mm`
 * each test file starts with the system clock at that local time today, so a suite can be checked
 * for depending on the time of day it runs at (#379):
 * `CODEDEN_TEST_CLOCK=23:50 pnpm exec vitest run --project @codeden/server apps/server/test/factory-`.
 * The root `vitest.config.ts` runs a sample of the factory, budget and digest suites this way at
 * 23:50 and 00:05. Meant for the in-process suites: a runner process the harness starts keeps the
 * real clock.
 */
const at = process.env.CODEDEN_TEST_CLOCK;
if (at) runClockFrom(todayAt(at));
