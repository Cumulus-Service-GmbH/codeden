/** Sample this runner process only. CPU time is measured since the previous sample. */
export function runnerProfile(enabled: boolean): (() => string) | undefined {
  if (!enabled) return undefined;
  let previous = process.cpuUsage();
  return () => {
    const current = process.cpuUsage();
    const cpuMs = (current.user - previous.user + current.system - previous.system) / 1_000;
    previous = current;
    const { rss, heapUsed } = process.memoryUsage();
    return `cpuMs=${cpuMs.toFixed(1)} rssBytes=${rss} heapUsedBytes=${heapUsed}`;
  };
}
