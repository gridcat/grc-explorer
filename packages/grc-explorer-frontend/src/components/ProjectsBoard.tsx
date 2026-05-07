import {
  Box, Card, CardContent, Chip, Stack, Tooltip, Typography,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import HistoryIcon from '@mui/icons-material/History';
import Link from 'next/link';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';

interface ProjectEntry {
  name: string;
  displayName: string;
  baseUrl: string;
  status: string;
  asOfBlock: number;
  asOfTime: number;
  zcd: number | null;
  was: number | null;
  meetsGreylistCriteria: boolean | null;
  gdprControls: boolean | null;
  requiresExternalAdapter: boolean | null;
}

interface ProjectsResponse {
  fetchedAt: number;
  cursorHeight: number;
  cursorHash: string;
  cursorTime: number | null;
  counts: { active: number; greylisted: number; delisted: number; total: number };
  active: ProjectEntry[];
  greylisted: ProjectEntry[];
  delisted: ProjectEntry[];
}

const POLL_MS = 60_000;
const MAX_DELISTED_VISIBLE = 8;

function formatCursorTime(unix: number | null): string {
  if (unix === null || !Number.isFinite(unix)) return '';
  const d = new Date(unix * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Three-column BOINC projects board: Whitelisted, Greylisted, De-listed.
 * Reconstructs project state from on-chain `project_contracts` events at
 * the indexer's current cursor — NOT the daemon's chain-tip view — so
 * the board stays consistent with the rest of the home page (blocks,
 * RAC, polls all reflect the same chain state).
 *
 * Refreshes on every `block.new` SSE so as backfill rolls forward, the
 * board updates when new project events come into view; SSE-direct
 * `project.added` / `project.removed` give the same effect with lower
 * latency. A 60s poll is the safety-net.
 */
export function ProjectsBoard() {
  const [snap, setSnap] = useState<ProjectsResponse | null>(null);
  const [showAllDelisted, setShowAllDelisted] = useState(false);
  const cancelledRef = useRef(false);

  const refresh = useCallback(() => {
    api.get('/projects').then((r) => {
      if (cancelledRef.current) return;
      const attrs = r.data?.data?.attributes as ProjectsResponse | undefined;
      if (attrs) setSnap(attrs);
    }).catch(() => { /* leave stale snapshot on transient errors */ });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
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
    active: 0, greylisted: 0, delisted: 0, total: 0,
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
          <Link
            href="/projects/history"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: 'inherit',
              fontSize: 12,
              opacity: 0.75,
              textDecoration: 'none',
            }}
          >
            <HistoryIcon sx={{ fontSize: 14 }} />
            History
          </Link>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Reconstructed from on-chain project contracts as the indexer has
          processed them. Greylist transitions are derived state and not
          yet computed here — column stays empty until the auto-greylist
          algorithm is ported.
        </Typography>


        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' },
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
            label="Greylisted"
            tone="warning"
            count={counts.greylisted}
            entries={snap?.greylisted ?? []}
            renderChip={GreyChip}
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
      {entry.baseUrl ? (
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

function ActiveChip({ gdprControls }: ProjectEntry) {
  if (!gdprControls) return null;
  return (
    <Tooltip title="Project enforces GDPR opt-in">
      <Chip label="GDPR" size="small" variant="outlined" sx={{ fontSize: 10, height: 18 }} />
    </Tooltip>
  );
}

function GreyChip({ status, zcd, was }: ProjectEntry) {
  // Daemon emits two greylist sub-states; surface them via different
  // chip styles so the column tells the operator whether removal was
  // automatic (criteria flipped) or driven by a community poll.
  const isManual = /manual/i.test(status);
  const label = isManual ? 'manual' : 'auto';
  const tooltip = isManual
    ? 'Greylisted by community poll'
    : `Auto-greylisted · zcd=${zcd ?? '?'} was=${was?.toFixed(2) ?? '?'}`;
  return (
    <Tooltip title={tooltip}>
      <Chip
        label={label}
        size="small"
        color={isManual ? 'warning' : 'default'}
        variant="outlined"
        sx={{ fontSize: 10, height: 18 }}
      />
    </Tooltip>
  );
}
