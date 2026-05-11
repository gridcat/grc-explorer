import { Box, Stack, Typography } from '@mui/material';
import { shortHash } from '../lib/format';

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
  return (
    <Stack spacing={0} sx={{ minWidth: 0, lineHeight: 1.15 }}>
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
        {name}
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
