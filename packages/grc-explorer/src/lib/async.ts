// Resolve after `ms` milliseconds. Small enough to inline, but copied
// in enough places (poll loops, backfill pacing, grace delays) to be
// worth one shared definition.
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
