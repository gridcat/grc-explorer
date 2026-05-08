import {
  Box, Card, CardContent, Chip, Stack, Typography,
} from '@mui/material';
import { keyframes } from '@emotion/react';
import Link from 'next/link';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';

// One-shot success pulse for rows transitioning to "confirmed". Holding
// a permanent green wash made every confirmed row dominate the panel
// long after the event was interesting. A 1.5s ease-out fades the glow
// to transparent and leaves the row neutral.
const pulseSuccess = keyframes`
  0%   { background-color: rgba(76, 175, 80, 0.32); }
  100% { background-color: transparent; }
`;

interface Entry {
  txId: string;
  enteredAt: number;
  state: 'pending' | 'confirmed' | 'evicted';
  isMrc: boolean;
}

const MAX = 12;

export function LiveTxFeed() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const cancelledRef = useRef(false);

  // Seed (and refresh) from the current mempool. Without the seed
  // path, the panel sat on "Watching for new mempool transactions…"
  // until the *next* SSE event — which on a quiet testnet may be a
  // long wait. Same call serves the safety-net poll below.
  const refresh = useCallback(() => {
    api.get('/mempool', { params: { 'page[size]': MAX } }).then((r) => {
      if (cancelledRef.current) return;
      const rows = (r.data?.data ?? []) as Array<{
        attributes: { txId: string; firstSeen: number; isMrc?: boolean };
      }>;
      const seeded: Entry[] = rows.map((d) => ({
        txId: d.attributes.txId,
        enteredAt: d.attributes.firstSeen * 1000,
        state: 'pending' as const,
        isMrc: Boolean(d.attributes.isMrc),
      }));
      setEntries((prev) => {
        // Prefer SSE-delivered state over polled — SSE may have already
        // marked some of these confirmed/evicted while the fetch was
        // in flight.
        const known = new Map(prev.map((e) => [e.txId, e]));
        const merged: Entry[] = [];
        for (const e of [...prev, ...seeded]) {
          if (known.has(e.txId) && merged.some((x) => x.txId === e.txId)) continue;
          if (merged.some((x) => x.txId === e.txId)) continue;
          merged.push(known.get(e.txId) ?? e);
        }
        return merged.slice(0, MAX);
      });
    }).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  // Safety-net poll for when SSE drops.
  useEffect(() => {
    const id = setInterval(refresh, 60 * 1000);
    return () => clearInterval(id);
  }, [refresh]);

  useSSE(['mempool.entered', 'mempool.exited'], (topic, payload) => {
    if (topic === 'mempool.entered') {
      const p = payload as { tx_id: string; is_mrc?: boolean };
      setEntries((prev) => {
        // Drop any stale row for the same txId before prepending.
        const filtered = prev.filter((e) => e.txId !== p.tx_id);
        return [
          {
            txId: p.tx_id, enteredAt: Date.now(), state: 'pending' as const, isMrc: Boolean(p.is_mrc),
          },
          ...filtered,
        ].slice(0, MAX);
      });
    } else if (topic === 'mempool.exited') {
      const p = payload as { tx_id: string; reason: 'confirmed' | 'evicted' };
      setEntries((prev) => prev.map((e) => (e.txId === p.tx_id ? { ...e, state: p.reason } : e)));
    }
  });

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle2" color="text.secondary">
          Live tx feed
        </Typography>
        <Stack divider={<Box sx={{ borderBottom: 1, borderColor: 'divider' }} />} sx={{ mt: 1 }}>
          {entries.map((e) => (
            <Stack
              key={e.txId}
              direction="row"
              spacing={1}
              sx={{
                py: 1,
                alignItems: 'center',
                opacity: e.state === 'evicted' ? 0.5 : 1,
                animation: e.state === 'confirmed' ? `${pulseSuccess} 1.5s ease-out` : 'none',
              }}
            >
              <Link href={`/transactions/${e.txId}`} style={{ flex: 1, textDecoration: 'none', color: 'inherit' }}>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {e.txId.slice(0, 16)}…{e.txId.slice(-6)}
                </Typography>
              </Link>
              {e.isMrc && (
                <Chip size="small" label="MRC" color="secondary" variant="outlined" />
              )}
              <Chip
                size="small"
                label={e.state}
                color={e.state === 'confirmed' ? 'success' : e.state === 'evicted' ? 'default' : 'primary'}
                variant={e.state === 'pending' ? 'filled' : 'outlined'}
              />
            </Stack>
          ))}
          {entries.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
              Watching for new mempool transactions…
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
