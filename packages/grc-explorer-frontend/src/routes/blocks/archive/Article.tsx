import { Box, Chip, Stack, Typography } from '@mui/material';
import { renderMarkdown } from '../../../lib/markdown';

/**
 * Renders an article body alongside its frontmatter highlights.
 *
 * Article body is markdown rendered through the project's minimal
 * renderer (which returns ReactNode[] directly, no innerHTML), wrapped
 * in a styled prose container. Highlights — releases, landmarks —
 * render as compact metadata rows above the prose so they're scannable
 * even before the reader has absorbed the long-form content.
 *
 * Stats provided by the page are substituted into `{{stat:NAME}}`
 * placeholders by the markdown layer at render time, so figures
 * remain live-from-CH instead of frozen in the markdown source.
 */

export interface ArticleData {
  data: Record<string, unknown>;
  body: string;
}

export interface ArticleStats {
  [key: string]: string | number;
}

export function ArticleBody({
  article,
  stats,
}: {
  article: ArticleData;
  stats?: ArticleStats;
}) {
  const nodes = renderMarkdown(article.body, { stats });
  const summary = typeof article.data.summary === 'string' ? article.data.summary : null;
  const heroEvent = typeof article.data.hero_event === 'string' ? article.data.hero_event : null;

  const releases = Array.isArray(article.data.releases) ? article.data.releases : [];
  const landmarks = Array.isArray(article.data.landmarks) ? article.data.landmarks : [];

  return (
    <Stack spacing={2.5}>
      {(heroEvent || summary) && (
        <Box>
          {heroEvent && (
            <Chip
              label={heroEvent}
              color="primary"
              size="small"
              sx={{ mb: 1, fontWeight: 600 }}
            />
          )}
          {summary && (
            <Typography variant="body1" color="text.secondary" sx={{ fontStyle: 'italic' }}>
              {summary}
            </Typography>
          )}
        </Box>
      )}

      {(releases.length > 0 || landmarks.length > 0) && (
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
          }}
        >
          {releases.length > 0 && <ReleasesPanel releases={releases as Array<Record<string, unknown>>} />}
          {landmarks.length > 0 && <LandmarksPanel landmarks={landmarks as Array<Record<string, unknown>>} />}
        </Box>
      )}

      <Box
        // Plain prose container — semantic tags inherit MUI's CSS
        // baseline. The renderer emits h2/h3/p/ul/li/a/strong/em/code,
        // styled below.
        sx={{
          '& h2': { mt: 4, mb: 1.5, fontSize: '1.5rem', fontWeight: 700 },
          '& h3': { mt: 3, mb: 1, fontSize: '1.15rem', fontWeight: 700 },
          '& p': { my: 1.5, lineHeight: 1.7 },
          '& ul': { pl: 3, my: 1.5 },
          '& li': { mb: 0.5, lineHeight: 1.6 },
          '& a': { color: 'primary.main', textDecoration: 'underline', textUnderlineOffset: 3 },
          '& code': {
            fontFamily: 'monospace',
            fontSize: '0.9em',
            px: 0.5,
            py: 0.1,
            bgcolor: 'action.hover',
            borderRadius: 0.5,
          },
        }}
      >
        {nodes}
      </Box>
    </Stack>
  );
}

function ReleasesPanel({ releases }: { releases: Array<Record<string, unknown>> }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: 11, mb: 1, display: 'block' }}
      >
        Wallet releases
      </Typography>
      <Stack spacing={0.5}>
        {releases.map((r, i) => (
          <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13 }}>
              {String(r.version ?? '?')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {String(r.date ?? '')}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function LandmarksPanel({ landmarks }: { landmarks: Array<Record<string, unknown>> }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: 11, mb: 1, display: 'block' }}
      >
        On-chain landmarks
      </Typography>
      <Stack spacing={0.5}>
        {landmarks.map((m, i) => (
          <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
            <Typography sx={{ fontFamily: 'monospace', fontSize: 13 }}>
              <a href={`/block/${m.block ?? ''}`} style={{ color: 'inherit' }}>
                {`#${m.block ?? '—'}`}
              </a>
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {String(m.label ?? '')}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}
