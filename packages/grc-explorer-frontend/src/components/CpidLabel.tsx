import { Box, Stack, Typography } from '@mui/material';
import { shortHash } from '../lib/format';

// Hard cap on BOINC display-name length when rendering. Some BOINC
// projects (Rosetta@home was the trigger) carry HTML-entity-encoded
// stylised names — a 5-character source like "Ãë×ô" gets stored as
// `&#195;&#171;&#215;&#180;…`, which is 20+ characters per visible
// glyph. Without a cap a single stylised name blows past every
// neighbouring column and "corrupts" the row layout. We truncate to
// 32 visible characters; the full original string remains in the
// hover `title` for anyone who wants to inspect it. The CPID hash
// underneath gives a stable click target regardless.
const NAME_MAX_RENDER = 32;

// Decode common HTML numeric entities so a single stylised glyph
// renders as one character instead of 5-15 entity bytes. Limited to
// numeric (&#NNN; / &#xNN;) form because that's what we see on chain;
// named entities (&amp; etc.) round-trip through React's own escaping.
function decodeNumericEntities(s: string): string {
  return s.replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code) => {
    const n = code.startsWith('x') || code.startsWith('X')
      ? parseInt(code.slice(1), 16)
      : parseInt(code, 10);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return _match;
    try { return String.fromCodePoint(n); } catch { return _match; }
  });
}

function renderName(raw: string): string {
  const decoded = decodeNumericEntities(raw);
  // Use Array.from to count code points correctly — emoji + stylised
  // glyphs are multi-byte and naive .length truncation can split a
  // surrogate pair.
  const chars = Array.from(decoded);
  if (chars.length <= NAME_MAX_RENDER) return decoded;
  return `${chars.slice(0, NAME_MAX_RENDER).join('')}…`;
}

/**
 * Two-line CPID label with the BOINC display name as primary info and
 * the short CPID hash beneath as a quiet identifier. Used by the home
 * page leaderboards and the LiveBlockTicker so researchers are
 * surfaced by name, not by a 32-char hex string — but the CPID stays
 * visible because it's the canonical chain identifier and people
 * who know each other by it (testnet contributors, the community
 * leaderboard regulars) shouldn't lose that anchor.
 *
 * When no name is known (anonymous BOINC user, or the project_users
 * import hasn't reached this CPID yet), falls back to the truncated
 * CPID rendered the way every existing leaderboard rendered it
 * before — so the layout stays stable while names trickle in.
 */
export function CpidLabel({
  cpid,
  name,
  monoSize = 10,
}: {
  cpid: string;
  name?: string;
  /** Font size for the muted CPID line. Smaller in dense tables. */
  monoSize?: number;
}) {
  if (!name) {
    return (
      <Typography
        variant="body2"
        sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}
        title={cpid}
      >
        {shortHash(cpid, 12, 6)}
      </Typography>
    );
  }
  const display = renderName(name);
  return (
    <Stack spacing={0} sx={{ minWidth: 0, maxWidth: 240, lineHeight: 1.15 }}>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={`${name} · ${cpid}`}
      >
        {display}
      </Typography>
      <Box
        component="span"
        sx={{
          fontFamily: 'monospace',
          fontSize: monoSize,
          color: 'text.disabled',
          whiteSpace: 'nowrap',
        }}
      >
        {shortHash(cpid, 8, 4)}
      </Box>
    </Stack>
  );
}
