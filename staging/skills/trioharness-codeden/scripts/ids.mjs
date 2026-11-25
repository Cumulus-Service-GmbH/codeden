// TrioHarness Lean — the one definition of a valid run id. '.' and '..' match the character class but name
// directories outside the run folder, so they are refused. A leading '-' is refused so an id can never read as a flag ('--gate'); ids starting with '.' or '_' stay valid.
export const validRunId = run => typeof run === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(run) && run !== '.' && run !== '..';
