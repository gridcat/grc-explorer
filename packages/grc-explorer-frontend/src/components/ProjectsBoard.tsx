import {
  Box, Button, Card, CardContent, Chip, Stack, Tooltip, Typography,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Link from 'next/link';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { SeeMoreButton } from './SeeMoreButton';

interface ProjectEntry {
  name: string;
  displayName: string;
  baseUrl: string;
  status: string;
  asOfBlock: number;
  asOfTime: number;
  gdprControls: boolean | null;
  requiresExternalAdapter: boolean | null;
  /** Daemon's live ProjectEntryStatus, populated by listprojects
   *  overlay only when the indexer is at-tip. One of "Active",
   *  "Manually Greylisted", "Automatically Greylisted", "Deleted",
   *  "Active by Greylist Override", "Unknown". Null when overlay
   *  couldn't run (backfill, RPC down). */
  currentChainStatus?: string | null;
}

export interface ProjectsResponse {
  fetchedAt: number;
  cursorHeight: number;
  cursorHash: string;
  cursorTime: number | null;
  counts: { active: number; delisted: number; total: number };
  active: ProjectEntry[];
  delisted: ProjectEntry[];
}

// Project add/remove events on chain are rare — a handful per year —
// so the primary refresh is the project.added / project.removed SSE
// below. This poll is purely a safety net for tabs that sit through
// an SSE drop or visibility-gated dispatch; 1 h is long enough to
// stay quiet on idle dashboards while still bounding staleness.
const POLL_MS = 60 * 60 * 1000;
const MAX_DELISTED_VISIBLE = 8;

// Validate that the on-chain `base_url` is something we can safely
// render as an `<a href>`. Delisted/legacy projects carry junk like
// "1" in this field; without the http(s) prefix check the browser
// resolves it as a same-origin path and the user lands on our own
// 404 page. Reject anything that isn't an absolute http(s) URL.
function isHttpUrl(s: string | null | undefined): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatCursorTime(unix: number | null): string {
  if (unix === null || !Number.isFinite(unix)) return '';
  const d = new Date(unix * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Two-column BOINC projects board: Whitelisted, De-listed.
 * Reconstructs project state from on-chain `project_contracts` events at
 * the indexer's current cursor — NOT the daemon's chain-tip view — so
 * the board stays consistent with the rest of the home page (blocks,
 * RAC, polls all reflect the same chain state).
 *
 * Refreshes on `project.added` / `project.removed` SSE — these events
 * fire on every relevant chain event with low latency. A 1 h poll is
 * the safety-net for SSE drops / hidden-tab dispatch gating.
 */
export function ProjectsBoard({
  initialSnap = null,
}: {
  initialSnap?: ProjectsResponse | null;
} = {}) {
  const [snap, setSnap] = useState<ProjectsResponse | null>(initialSnap);
  const [showAllDelisted, setShowAllDelisted] = useState(false);
  const cancelledRef = useRef(false);
  const skipFirstFetchRef = useRef(initialSnap !== null);

  const refresh = useCallback(() => {
    api.get('/projects').then((r) => {
      if (cancelledRef.current) return;
      const attrs = r.data?.data?.attributes as ProjectsResponse | undefined;
      if (attrs) setSnap(attrs);
    }).catch(() => { /* leave stale snapshot on transient errors */ });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
    } else {
      refresh();
    }
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Project events are rare; refetch on each.
  useSSE(['project.added', 'project.removed'], () => {
    refresh();
  });

  const counts = snap?.counts ?? {
    active: 0, delisted: 0, total: 0,
  };
  const cursorLabel = snap
    ? `block #${snap.cursorHeight.toLocaleString()}${snap.cursorTime ? ` · ${formatCursorTime(snap.cursorTime)}` : ''}`
    : 'loading…';

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Stack direction="row" sx={{ alignItems: 'baseline', mb: 0.5, gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
            BOINC projects · chain state at {cursorLabel}
          </Typography>
          {snap && (
            <Typography variant="caption" color="text.secondary">
              {`${counts.total} total · ${counts.active} earning`}
            </Typography>
          )}
          <SeeMoreButton href="/projects/history" label="See history" />
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Reconstructed from on-chain project contracts as the indexer has
          processed them.
        </Typography>


        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          }}
        >
          <ProjectColumn
            label="Whitelisted"
            tone="success"
            count={counts.active}
            entries={snap?.active ?? []}
            renderChip={ActiveChip}
          />
          <ProjectColumn
            label="De-listed"
            tone="default"
            count={counts.delisted}
            entries={snap?.delisted ?? []}
            renderChip={() => null}
            collapsed={!showAllDelisted}
            onToggleCollapse={() => setShowAllDelisted((v) => !v)}
            limit={showAllDelisted ? undefined : MAX_DELISTED_VISIBLE}
          />
        </Box>
      </CardContent>
    </Card>
  );
}

interface ProjectColumnProps {
  label: string;
  tone: 'success' | 'warning' | 'default';
  count: number;
  entries: ProjectEntry[];
  renderChip: (entry: ProjectEntry) => React.ReactNode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  limit?: number;
}

function ProjectColumn({
  label, tone, count, entries, renderChip, collapsed, onToggleCollapse, limit,
}: ProjectColumnProps) {
  const visible = useMemo(() => (
    typeof limit === 'number' ? entries.slice(0, limit) : entries
  ), [entries, limit]);
  const hidden = entries.length - visible.length;

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1, gap: 1 }}>
        <Chip
          label={`${label} · ${count}`}
          size="small"
          color={tone}
          variant={tone === 'default' ? 'outlined' : 'filled'}
        />
      </Stack>
      <Stack
        spacing={0.5}
        sx={{
          maxHeight: 360,
          overflowY: 'auto',
          pr: 0.5,
        }}
      >
        {visible.length === 0 ? (
          <Typography variant="caption" color="text.disabled" sx={{ py: 1 }}>
            No projects.
          </Typography>
        ) : visible.map((p) => (
          <ProjectRow key={p.name} entry={p} chip={renderChip(p)} />
        ))}
        {hidden > 0 && onToggleCollapse && (
          <Box
            component="button"
            type="button"
            onClick={onToggleCollapse}
            sx={{
              border: 'none',
              bgcolor: 'transparent',
              color: 'primary.main',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 12,
              p: 0.5,
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            {collapsed ? `Show ${hidden} more…` : 'Show fewer'}
          </Box>
        )}
      </Stack>
    </Box>
  );
}

function ProjectRow({ entry, chip }: { entry: ProjectEntry; chip: React.ReactNode }) {
  // Chip and the ↗ icon sit immediately after the project name (not
  // flushed to the row's right edge) so they are unambiguously
  // associated with this row. The previous shape had `flex: 1` on the
  // Link which pushed the chip + icon to the far right; in a 3-column
  // grid that put them visually nearer the next column's first row
  // than this row's name. Subtle bottom-border on each row reinforces
  // the row boundary too.
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        gap: 0.75,
        py: 0.5,
        minHeight: 28,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Link
        href={`/projects/${encodeURIComponent(entry.name)}`}
        style={{
          color: 'inherit',
          textDecoration: 'none',
          // `0 1 auto` lets the name shrink-and-truncate when the
          // column is narrow but does not force it to occupy the full
          // remaining width; chip + icon end up adjacent to the name.
          flex: '0 1 auto',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <Typography
          variant="body2"
          sx={{
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            ':hover': { textDecoration: 'underline' },
          }}
          title={entry.displayName}
        >
          {entry.displayName}
        </Typography>
      </Link>
      {chip}
      {isHttpUrl(entry.baseUrl) ? (
        <Tooltip title={entry.baseUrl} placement="top">
          <a
            href={entry.baseUrl.replace(/@$/, '')}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', color: 'inherit', opacity: 0.6,
            }}
            aria-label={`Open ${entry.displayName}`}
          >
            <OpenInNewIcon sx={{ fontSize: 14 }} />
          </a>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

function ActiveChip({ gdprControls, currentChainStatus }: ProjectEntry) {
  // Daemon's live status takes precedence — when the indexer is at
  // tip we know the actual ProjectEntryStatus. AUTO_GREYLIST_OVERRIDE
  // is the V13 highlight: the project would have been auto-greylisted
  // by the algorithm, but a master-signed contract kept it active.
  // The GDPR chip is independent — orthogonal flag.
  const gdpr = gdprControls ? (
    <Tooltip key="gdpr" title="Project enforces GDPR opt-in">
      <Chip label="GDPR" size="small" variant="outlined" sx={{ fontSize: 10, height: 18 }} />
    </Tooltip>
  ) : null;
  const statusChip = (() => {
    if (!currentChainStatus) return null;
    switch (currentChainStatus) {
      case 'Active by Greylist Override':
        return (
          <Tooltip key="status" title="The project would have been auto-greylisted by the algorithm, but a master-signed override contract keeps it active. V13 feature.">
            <Chip label="Override" size="small" color="primary" variant="filled" sx={{ fontSize: 10, height: 18, fontWeight: 600 }} />
          </Tooltip>
        );
      case 'Manually Greylisted':
        return (
          <Tooltip key="status" title="Manually greylisted by master-signed contract.">
            <Chip label="Greylisted" size="small" color="warning" variant="outlined" sx={{ fontSize: 10, height: 18 }} />
          </Tooltip>
        );
      case 'Automatically Greylisted':
        return (
          <Tooltip key="status" title="Auto-greylisted by the V13 algorithm (Zero Credit Days / Whitelist Activity Score).">
            <Chip label="Auto-greylisted" size="small" color="warning" variant="outlined" sx={{ fontSize: 10, height: 18 }} />
          </Tooltip>
        );
      default:
        return null; // 'Active', 'Deleted', 'Unknown' — no extra chip
    }
  })();
  if (!gdpr && !statusChip) return null;
  return <>{statusChip}{gdpr}</>;
}
