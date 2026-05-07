import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';

// Older Gridcoin builds packed `getnetworkinfo.version` as
// `major*1e6 + minor*1e4 + patch*1e2 + build`; current builds ship a
// human string like `"v5.5.0.1-unk"`. Accept either.
function formatVersion(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    const trimmed = v.replace(/^v/, '').trim();
    return trimmed.length > 0 ? `v${trimmed}` : '';
  }
  if (v <= 0) return '';
  const major = Math.floor(v / 1_000_000);
  const minor = Math.floor(v / 10_000) % 100;
  const patch = Math.floor(v / 100) % 100;
  const build = v % 100;
  return `v${major}.${minor}.${patch}.${build}`;
}

interface NetworkAttrs {
  net_version?: number | string;
  peer_count?: number;
}

// Footer block describing the wallet daemon we're talking to. Reads
// from /network on mount, then keeps `peer_count` live via the
// `network.stats` SSE topic (15 s cadence). One line per fact so the
// footer's vertical rhythm stays readable.
export function DaemonInfo() {
  const [version, setVersion] = useState<string>('');
  const [peers, setPeers] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api.get('/network')
      .then((r) => {
        if (!alive) return;
        const attrs = (r.data?.data?.attributes ?? {}) as NetworkAttrs;
        const formatted = formatVersion(attrs.net_version);
        if (formatted) setVersion(formatted);
        if (typeof attrs.peer_count === 'number') setPeers(attrs.peer_count);
      })
      .catch(() => { /* footer renders without it */ });
    return () => { alive = false; };
  }, []);

  // Live peer-count updates ride on the network.stats SSE topic —
  // pushed by NetworkStatsPoller every ~15 s.
  useSSE(['network.stats'], (_topic, payload) => {
    const p = payload as NetworkAttrs;
    if (typeof p.peer_count === 'number') setPeers(p.peer_count);
    // Version doesn't normally change, but if a daemon is restarted
    // mid-session let the new value through.
    const formatted = formatVersion(p.net_version);
    if (formatted) setVersion(formatted);
  });

  if (!version && peers === null) return null;
  return (
    <Box component="span" sx={{ display: 'inline-block', lineHeight: 1.6 }}>
      {version && (
        <Box component="span" sx={{ display: 'block' }}>
          {`daemon ${version}`}
        </Box>
      )}
      {peers !== null && (
        <Box component="span" sx={{ display: 'block' }}>
          {`${peers.toLocaleString()} peer${peers === 1 ? '' : 's'}`}
        </Box>
      )}
    </Box>
  );
}
