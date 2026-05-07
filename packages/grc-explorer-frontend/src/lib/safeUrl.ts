// Defensive URL allowlist used wherever the explorer renders a
// user-supplied URL into an anchor tag. Any chain-sourced field that
// ends up in `href=` (poll URL, future beacon homepage, etc.) MUST go
// through this helper, even if the surrounding code is currently
// author-only — a future change that wires user input into the same
// path would otherwise inherit a stored-XSS hole.
//
// Allowlist — anything else is dropped (returns null):
//   - http://… / https://…
//   - mailto:…
//   - relative paths starting with /, #, or ?
//
// React already escapes attribute values, so HTML or quote injection
// inside an href can't break out into a new attribute. The risk this
// helper closes is the *scheme* family that runs code on click.
//
// Why we trim leading whitespace + control bytes first: browsers
// resolve `href` after stripping the same character class when picking
// the scheme. Without the trim, a hostile string with a leading tab or
// newline could pass a naïve prefix check and still execute under the
// browser's own scheme detection.

const SAFE_SCHEME = /^(https?:|mailto:)/i;
const RELATIVE = /^[/#?]/;

export function safeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  // Skip leading bytes <= 0x20 (covers SP, TAB, CR, LF, FF, VT, plus
  // every other C0 control). charCode loop instead of a regex with a
  // unicode escape so we're not at the mercy of the source pipeline
  // re-encoding the literal characters in our pattern.
  let i = 0;
  while (i < input.length && input.charCodeAt(i) <= 0x20) i += 1;
  const trimmed = i === 0 ? input : input.slice(i);
  if (RELATIVE.test(trimmed) || SAFE_SCHEME.test(trimmed)) return trimmed;
  return null;
}
