import {
  Box, Button, IconButton, MenuItem, Paper, Select, Slider, Stack, Tooltip, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import HistoryIcon from '@mui/icons-material/History';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import LinkIcon from '@mui/icons-material/Link';
import { useState } from 'react';
import { Speed, SPEEDS, useTimeMachine } from '../hooks/useTimeMachine';
import { formatDuration } from '../lib/format';

/**
 * Bottom-fixed time-machine dock — shown on every page since the
 * provider is global. Two modes:
 *
 *   Live: a compact floating pill at bottom-right with a clock icon,
 *         labelled "Time machine". One click enters replay.
 *   Replay: a full-width fixed dock at the bottom of the viewport,
 *         like a music player. Includes the slider, transport, speed,
 *         a precise datetime picker, and quick-jump presets that
 *         resolve the 11+ years of chain history into one-click jumps.
 *
 * `Layout.tsx` reserves bottom padding on the main content so nothing
 * sits under the dock.
 */
export function TimeMachineDock() {
  const tm = useTimeMachine();
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(window.location.href).catch(() => { /* ignore */ });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Live mode: small floating pill bottom-left. The right edge is
  // already taken by the scroll-to-top FAB; living on the left keeps
  // both reachable without overlap.
  if (!tm.isReplay) {
    return (
      <Box
        sx={{
          position: 'fixed',
          left: { xs: 12, sm: 24 },
          bottom: { xs: 12, sm: 24 },
          zIndex: theme.zIndex.appBar,
        }}
      >
        <Button
          variant="contained"
          color="secondary"
          startIcon={<HistoryIcon />}
          onClick={() => tm.enterReplay()}
          sx={{
            borderRadius: 50,
            px: 2.25,
            py: 1,
            textTransform: 'none',
            boxShadow: 4,
            fontWeight: 600,
          }}
        >
          Time machine
        </Button>
      </Box>
    );
  }

  // Replay mode — full dock.
  const min = tm.bounds?.minTs ?? 0;
  const max = tm.bounds?.maxTs ?? Math.floor(Date.now() / 1000);
  const committedAt = tm.at ?? max;
  // Local "scrubbing" override. While the user is actively dragging the
  // slider we paint with this value but DON'T broadcast — every pixel
  // of drag would otherwise trigger a refetch in every panel. Once the
  // user releases (Slider's onChangeCommitted), we push the final value
  // up to the context and the consumers refetch exactly once.
  const [scrubAt, setScrubAt] = useState<number | null>(null);
  const cur = scrubAt ?? committedAt;
  const formattedCur = new Date(cur * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const distanceFromTip = Math.max(0, max - cur);

  // Quick-jump targets, all relative to chain tip. Resolves the
  // multi-year slider span into single-click jumps to the windows
  // people actually want.
  const presets: Array<{ label: string; deltaSec: number }> = [
    { label: '1h', deltaSec: 3600 },
    { label: '1d', deltaSec: 86_400 },
    { label: '1w', deltaSec: 86_400 * 7 },
    { label: '1mo', deltaSec: 86_400 * 30 },
    { label: '1y', deltaSec: 86_400 * 365 },
  ];
  const jumpAgo = (deltaSec: number) => {
    const target = Math.max(min, max - deltaSec);
    tm.setAt(target);
  };
  const jumpGenesis = () => tm.setAt(min);

  // datetime-local <input> uses local time without seconds, format
  // `YYYY-MM-DDTHH:MM`. Convert unix-seconds → that string and back.
  const datetimeInputValue = unixToLocalInput(cur);
  const handleDatetimeChange = (raw: string) => {
    const ts = localInputToUnix(raw);
    if (ts === null) return;
    tm.setAt(Math.min(max, Math.max(min, ts)));
  };

  return (
    <Paper
      elevation={6}
      sx={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: theme.zIndex.appBar,
        borderTop: 1,
        borderColor: 'secondary.main',
        bgcolor: 'background.paper',
        backdropFilter: 'blur(8px)',
        px: { xs: 1.5, sm: 3 },
        py: { xs: 1.25, sm: 1.5 },
      }}
    >
      <Stack spacing={1}>
        {/* Top row: status, slider, transport */}
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          useFlexGap
          sx={{ alignItems: { xs: 'stretch', md: 'center' } }}
        >
          {/* Status badge + readable clock */}
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0, flexShrink: 0 }}>
            <Typography
              variant="caption"
              sx={{
                textTransform: 'uppercase',
                letterSpacing: 1.2,
                fontWeight: 700,
                color: 'secondary.main',
              }}
            >
              Replay
            </Typography>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600, fontSize: { xs: '0.95rem', sm: '1.05rem' }, lineHeight: 1.15 }}>
                {formattedCur}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {distanceFromTip === 0 ? 'at chain tip' : `${formatDuration(distanceFromTip)} before tip`}
              </Typography>
            </Box>
          </Stack>

          {/* Slider — gets the most horizontal real estate. */}
          <Box sx={{ flexGrow: 1, mx: { xs: 0, md: 2 } }}>
            <Slider
              size="small"
              value={cur}
              min={min}
              max={max}
              onChange={(_e, v) => {
                if (typeof v === 'number') setScrubAt(v);
              }}
              onChangeCommitted={(_e, v) => {
                if (typeof v === 'number') tm.setAt(v);
                setScrubAt(null);
              }}
              valueLabelDisplay="off"
              color="secondary"
            />
          </Box>

          {/* Transport controls. */}
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
            <Tooltip title="Step back 5 minutes">
              <span>
                <IconButton size="small" onClick={() => tm.step(-300)} aria-label="step back 5 minutes">
                  <SkipPreviousIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={tm.playing ? 'Pause' : 'Play'}>
              <IconButton
                size="medium"
                color="secondary"
                onClick={tm.togglePlay}
                aria-label={tm.playing ? 'pause replay' : 'play replay'}
                sx={{ bgcolor: 'secondary.main', color: 'common.white', ':hover': { bgcolor: 'secondary.dark' } }}
              >
                {tm.playing ? <PauseIcon /> : <PlayArrowIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Step forward 5 minutes">
              <span>
                <IconButton size="small" onClick={() => tm.step(300)} aria-label="step forward 5 minutes">
                  <SkipNextIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Select
              size="small"
              value={tm.speed}
              onChange={(e) => tm.setSpeed(Number(e.target.value) as Speed)}
              sx={{ ml: 1, minWidth: 78, fontSize: 13, '& .MuiSelect-select': { py: 0.5 } }}
              aria-label="playback speed"
            >
              {SPEEDS.map((s) => (
                <MenuItem key={s} value={s} sx={{ fontSize: 13 }}>
                  {s}× speed
                </MenuItem>
              ))}
            </Select>
            <Tooltip title={copied ? 'Copied!' : 'Copy shareable link'}>
              <IconButton size="small" onClick={handleCopyLink} aria-label="copy shareable link">
                <LinkIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Button
              size="small"
              variant="contained"
              color="success"
              onClick={() => {
                setScrubAt(null);
                tm.goLive();
              }}
              aria-label="return to live"
              sx={{
                ml: 0.5,
                textTransform: 'none',
                fontWeight: 700,
                px: 1.5,
                py: 0.5,
                minWidth: 0,
              }}
              startIcon={(
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: 'common.white',
                    animation: 'pulse 2s ease-in-out infinite',
                    '@keyframes pulse': {
                      '0%': { opacity: 1 }, '50%': { opacity: 0.3 }, '100%': { opacity: 1 },
                    },
                  }}
                />
              )}
            >
              Live
            </Button>
          </Stack>
        </Stack>

        {/* Bottom row: precise picker + quick jumps. The whole row
            collapses to a horizontal scroll on phones so the dock
            never grows past two lines tall. */}
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{
            alignItems: 'center',
            flexWrap: { xs: 'nowrap', sm: 'wrap' },
            overflowX: { xs: 'auto', sm: 'visible' },
            pb: { xs: 0.5, sm: 0 },
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            Jump to:
          </Typography>
          <Box
            component="input"
            type="datetime-local"
            value={datetimeInputValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleDatetimeChange(e.target.value)}
            min={unixToLocalInput(min)}
            max={unixToLocalInput(max)}
            sx={{
              fontFamily: 'inherit',
              fontSize: 12,
              padding: '4px 6px',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'background.paper',
              color: 'text.primary',
              colorScheme: theme.palette.mode,
              flexShrink: 0,
            }}
            aria-label="precise replay timestamp"
          />
          <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, mx: 0.5 }}>
            or
          </Typography>
          {presets.map((p) => (
            <Button
              key={p.label}
              size="small"
              variant="outlined"
              color="secondary"
              onClick={() => jumpAgo(p.deltaSec)}
              sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: 12, flexShrink: 0 }}
            >
              {`${p.label} ago`}
            </Button>
          ))}
          <Button
            size="small"
            variant="text"
            color="secondary"
            onClick={jumpGenesis}
            sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: 12, flexShrink: 0 }}
          >
            Genesis
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

/**
 * Format a Unix-seconds value for `<input type="datetime-local">`.
 * Strips seconds and timezone — matches what the input expects. Values
 * are interpreted as the user's local time, which is consistent with
 * the formatted clock displayed alongside.
 */
function unixToLocalInput(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToUnix(raw: string): number | null {
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
