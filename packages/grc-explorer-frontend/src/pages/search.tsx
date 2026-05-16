import {
  Card, CardContent, CircularProgress, Stack, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Layout } from '../layouts/Layout';
import { Crumbs } from '../components/Crumbs';
import { api } from '../lib/api';
import { track } from '../lib/track';

interface IndexResult {
  index: string;
  hits: Array<Record<string, unknown>>;
  estimatedTotalHits?: number;
}

interface SearchPageProps {
  initialQ: string;
  initialResults: IndexResult[];
  initialLoaded: boolean;
}

export default function SearchPage({ initialQ, initialResults, initialLoaded }: SearchPageProps) {
  const router = useRouter();
  const q = String(router.query.q ?? '');
  const [results, setResults] = useState<IndexResult[]>(initialResults);
  const [loaded, setLoaded] = useState(initialLoaded);

  useEffect(() => {
    if (!q) {
      setResults([]);
      setLoaded(false);
      return;
    }
    if (q === initialQ && initialLoaded) return;
    setLoaded(false);
    api.get('/search', { params: { q, limit: 20 } }).then((r) => {
      setResults((r.data?.data ?? []) as IndexResult[]);
    }).catch(() => {
      setResults([]);
    }).finally(() => setLoaded(true));
  }, [q, initialQ, initialLoaded]);

  // Hide indices that returned nothing — the API queries every index
  // (blocks, transactions, addresses, claims, superblocks, polls,
  // beacons) and most queries hit only one or two of them. Showing an
  // empty card per non-matching index made the page feel like the search
  // was broken.
  const nonEmpty = results.filter((r) => r.hits.length > 0);
  const totalHits = results.reduce((acc, r) => acc + r.hits.length, 0);

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[{ label: 'Search' }]} />
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Search</Typography>
        <Typography variant="body1" color="text.secondary">
          Results for <strong>{q || '(none)'}</strong>
        </Typography>
        {q && !loaded && (
          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <CircularProgress size={18} thickness={5} />
                <Typography variant="body2" color="text.secondary">
                  Searching the chain for <strong>{q}</strong>…
                </Typography>
              </Stack>
            </CardContent>
          </Card>
        )}
        {loaded && nonEmpty.map((r) => (
          <Card key={r.index} variant="outlined">
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary" sx={{ textTransform: 'capitalize' }}>
                {prettyIndex(r.index)} ({r.estimatedTotalHits ?? r.hits.length})
              </Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {r.hits.map((hit, i) => (
                  <Hit key={`${r.index}:${i}`} index={r.index} hit={hit} />
                ))}
              </Stack>
            </CardContent>
          </Card>
        ))}
        {q && loaded && totalHits === 0 && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                Nothing matched <strong>{q}</strong>. Try a hash, height, address, CPID, or poll title.
              </Typography>
            </CardContent>
          </Card>
        )}
      </Stack>
    </Layout>
  );
}

// Maps the Meili index name to a human-readable section heading.
// Most index names work as-is once title-cased (capitalize CSS does
// the lifting), but multi-word internal names like `cpid_names` need
// an explicit override so the user doesn't see "Cpid_names" as a
// section label.
function prettyIndex(index: string): string {
  if (index === 'cpid_names') return 'Researchers (by name)';
  return index;
}

function linkFor(index: string, hit: Record<string, unknown>): string {
  switch (index) {
    case 'blocks': return `/block/${hit.height}`;
    case 'transactions': return `/transactions/${hit.tx_id}`;
    case 'addresses': return `/addresses/${hit.address}`;
    case 'claims': return `/block/${hit.block_height}`;
    case 'superblocks': return `/superblocks/${hit.height}`;
    case 'polls': return `/polls/${hit.id}`;
    case 'beacons': return `/cpids/${hit.cpid}`;
    // messages docs key the tx id as `id` (BlockWriter writes
    // `id: msg.txId`); there is no `tx_id` field — using it gave
    // `/transactions/undefined`.
    case 'messages': return `/transactions/${hit.tx_id ?? hit.id}`;
    case 'cpid_names': return `/cpids/${hit.cpid}`;
    default: return '#';
  }
}

function Hit({ index, hit }: { index: string; hit: Record<string, unknown> }) {
  const labelFor = () => {
    switch (index) {
      case 'blocks': return `#${hit.height} · ${hit.is_superblock ? 'superblock' : 'block'}`;
      case 'transactions': return String(hit.tx_id);
      case 'addresses': return String(hit.address);
      case 'claims': return `#${hit.block_height} · ${hit.organization || hit.cpid}`;
      case 'superblocks': return `#${hit.height} · superblock`;
      case 'polls': return String(hit.title);
      case 'beacons': return `${hit.cpid} · ${hit.address}`;
      case 'messages': {
        // First line of the message (or a 80-char prefix) plus the
        // block height — gives the user enough context to recognise
        // the memo without dumping a multi-line essay into the list.
        const raw = String(hit.message ?? '');
        const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
        const snippet = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
        return `"${snippet}" · #${hit.block_height ?? '?'}`;
      }
      case 'cpid_names': {
        // BOINC display-name match. Show the name + CPID + which project
        // attested it, so the user can tell apart users with the same
        // alias across projects. CPID is the resolution target — the
        // link lands on /cpids/<cpid>.
        const name = String(hit.name ?? '');
        const cpid = String(hit.cpid ?? '');
        const project = String(hit.project_name ?? '');
        const tail = project ? ` · ${project}` : '';
        return `${name} · ${cpid}${tail}`;
      }
      default: return JSON.stringify(hit);
    }
  };
  return (
    <Link
      href={linkFor(index, hit)}
      style={{ color: 'inherit', textDecoration: 'none' }}
      onClick={() => track('Search: hit click', { index })}
    >
      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 13, py: 0.5, ':hover': { textDecoration: 'underline' } }}>
        {labelFor()}
      </Typography>
    </Link>
  );
}

export const getServerSideProps: GetServerSideProps<SearchPageProps> = async (ctx) => {
  const qRaw = ctx.query?.q;
  const q = typeof qRaw === 'string' ? qRaw : '';
  if (!q) {
    return { props: { initialQ: '', initialResults: [], initialLoaded: false } };
  }
  try {
    const r = await api.get('/search', { params: { q, limit: 20 } });
    const initialResults = (r.data?.data ?? []) as IndexResult[];

    // Single-hit shortcut: when the federated search collapses to
    // exactly one match across every index, skip the results page
    // entirely and 302 the user straight to that destination. Saves
    // a click for the common "paste a tx id / block hash / CPID /
    // address" flow.
    let totalHits = 0;
    let onlyHit: { index: string; hit: Record<string, unknown> } | null = null;
    for (const bucket of initialResults) {
      for (const hit of bucket.hits) {
        totalHits += 1;
        if (totalHits === 1) onlyHit = { index: bucket.index, hit };
        if (totalHits > 1) break;
      }
      if (totalHits > 1) break;
    }
    if (totalHits === 1 && onlyHit) {
      const dest = linkFor(onlyHit.index, onlyHit.hit);
      if (dest && dest !== '#') {
        return { redirect: { destination: dest, permanent: false } };
      }
    }

    return {
      props: {
        initialQ: q,
        initialResults,
        initialLoaded: true,
      },
    };
  } catch {
    // SSR /search failed (timeout / transient). Do NOT claim it
    // loaded: the client guard `q === initialQ && initialLoaded`
    // would then skip its own fetch and the page would show a
    // permanent "Nothing matched" even though the API is healthy.
    // initialLoaded:false lets the client retry and recover.
    return { props: { initialQ: q, initialResults: [], initialLoaded: false } };
  }
};
