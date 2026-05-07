/**
 * Frontend feature flags. Flip a constant here to enable/disable a
 * surface across the whole app without touching call sites.
 *
 * Each flag is a plain `const`. Compile-time dead-code elimination
 * means flipped-off features don't ship in the bundle either —
 * `if (false) {}` blocks get tree-shaken. No runtime cost.
 */

/**
 * Time-machine dock + replay-mode URL parsing. Off for the first
 * deploy: the underlying provider, API `?at=` support, and bitemporal
 * data are all still in place; only the user-facing entry points and
 * URL-state restore are gated.
 *
 * Flip to `true` once the dock UX is tuned (see chat history for the
 * outstanding follow-ups).
 */
export const TIME_MACHINE_ENABLED = false;
