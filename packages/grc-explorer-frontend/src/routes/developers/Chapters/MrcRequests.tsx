import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function MrcRequests() {
  return (
    <Box id="mrc-requests" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
        MRC requests
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Manual Researcher Compensation: a researcher submits an MRC
        request transaction with a small bid fee, and a future staker
        bundles the payout into the next block&apos;s claim. Endpoints
        below cover both pending requests (caught in mempool) and
        confirmed ones (matched to a block via tx_id).
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Status taxonomy is the same across all routes:
        <code> confirmed</code> — staker bundled the payout (block_height set);
        <code> evicted</code> — never confirmed, mempool tx fell out;
        <code> pending</code> — neither, still waiting for inclusion.
        <code> waitSeconds</code> is <code>blockTime − firstSeen</code> for
        confirmed requests the explorer actually saw enter mempool, and
        <code> null</code> for historical replay rows where{' '}
        <code>firstSeen = blockTime</code>.
      </Typography>

      <Typography variant="h6" component="h3" id="mrc-list" sx={{ pt: 2, pb: 1 }}>
        List MRC requests
      </Typography>
      <Endpoint method="GET" path="/api/mrc-requests" title="Paginated, filterable" />
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>cpid</code>: filter by researcher CPID (32 hex)</>}
            secondary="Optional. Combines with status."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>status</code>: <code>pending</code> | <code>confirmed</code> | <code>evicted</code></>}
            secondary="Optional. Omit for all."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>page[size]</code>, <code>page[offset]</code></>}
            secondary="Standard pagination. Sort is firstSeen DESC."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/mrc-requests?status=confirmed&page[size]=2'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 18 },
  "data": [
    {
      "type": "mrc_request",
      "id": "4f0d7710c3ae6fd8b3c88a03863e2ce14b2eaf6362acff45dbb400356466fa9f",
      "attributes": {
        "txId": "4f0d7710...",
        "version": 1,
        "cpid": "0ca9e97f18b87e18cbcd9dc98bb37864",
        "clientVersion": "v5.5.0.0",
        "organization": "Darren Steer",
        "researchSubsidy": "1228.01444214",
        "feeOffered": "0.01093607",
        "magnitude": 0,
        "magnitudeUnit": 0,
        "lastBlockHash": "0d648484af1f7b...",
        "payToAddress": "n3ofNpzf1cwRG8...",
        "firstSeen": 1776612237,
        "blockHeight": 3154442,
        "blockTime": 1776612240,
        "status": "confirmed",
        "waitSeconds": 3
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="mrc-summary" sx={{ pt: 2, pb: 1 }}>
        Summary
      </Typography>
      <Endpoint method="GET" path="/api/mrc-requests/summary" title="Lifetime + 24h totals" />
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mrc-requests/summary'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "data": {
    "type": "mrc_summary",
    "id": "now",
    "attributes": {
      "confirmedCount": 18,
      "confirmedResearchTotal": "27842.13",
      "confirmedFeeTotal": "1.834",
      "last24hCount": 0,
      "last24hResearchTotal": "0",
      "distinctCpids": 5,
      "pendingCount": 0,
      "evictedCount": 0
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="mrc-timeline" sx={{ pt: 2, pb: 1 }}>
        Daily activity
      </Typography>
      <Endpoint method="GET" path="/api/mrc-requests/timeline" title="Confirmed-MRC count + payouts per day" />
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>days</code>: window length</>}
            secondary="Default 30, max 365."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mrc-requests/timeline?days=30'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "mrc_timeline",
    "id": "last_30d",
    "attributes": {
      "days": 30,
      "samples": [
        { "ts": 1773014400, "count": 1, "researchTotal": "1228.01",
          "feeTotal": "0.01093607", "distinctCpids": 1 }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="mrc-wait-distribution" sx={{ pt: 2, pb: 1 }}>
        Wait-time distribution
      </Typography>
      <Endpoint method="GET" path="/api/mrc-requests/wait-distribution" title="Histogram of mempool wait" />
      <Typography gutterBottom variant="body1" component="p">
        Buckets the <code>blockTime − firstSeen</code> delta for confirmed
        MRCs the explorer observed enter mempool. Historical replay rows
        (where <code>firstSeen == blockTime</code>) are excluded so the
        distribution reflects real wait times only.
      </Typography>
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>days</code>: window length</>}
            secondary="Default 90, max 730."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mrc-requests/wait-distribution?days=90'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "data": {
    "type": "mrc_wait_distribution",
    "id": "last_90d",
    "attributes": {
      "days": 90,
      "buckets": [
        { "label": "<30s",   "count": 12 },
        { "label": "30s–1m", "count": 4 },
        { "label": "1–5m",   "count": 1 },
        { "label": "5–15m",  "count": 0 },
        { "label": "15m–1h", "count": 0 },
        { "label": "1–6h",   "count": 0 },
        { "label": ">6h",    "count": 0 }
      ],
      "p50Seconds": 8,
      "p95Seconds": 47
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="mrc-bid-vs-payout" sx={{ pt: 2, pb: 1 }}>
        Bid fee vs. requested payout
      </Typography>
      <Endpoint method="GET" path="/api/mrc-requests/bid-vs-payout" title="Sample of (research, fee) pairs" />
      <Typography gutterBottom variant="body1" component="p">
        Returns up to <code>limit</code> recent confirmed MRCs as raw
        scatter points so a client can render the fee-market shape
        without re-aggregating. Capped server-side at 5000.
      </Typography>
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>days</code>: window length</>}
            secondary="Default 30, max 365."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>limit</code>: max points returned</>}
            secondary="Default 500, max 5000."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mrc-requests/bid-vs-payout?days=30&limit=500'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "mrc_bid_vs_payout",
    "id": "last_30d",
    "attributes": {
      "days": 30,
      "limit": 500,
      "points": [
        { "researchSubsidy": "1228.01", "feeOffered": "0.01093607",
          "blockTime": 1776612240,
          "cpid": "0ca9e97f18b87e18cbcd9dc98bb37864" }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="mrc-staker-take" sx={{ pt: 2, pb: 1 }}>
        Staker take
      </Typography>
      <Endpoint method="GET" path="/api/mrc-requests/staker-take" title="Daily fee splits at the block level" />
      <Typography gutterBottom variant="body1" component="p">
        Aggregates <code>claims.mrc_staker_fees</code> and
        <code> claims.mrc_foundation_fees</code> per UTC day. Source is
        the chain&apos;s own fee-split accounting (block-level), not
        derivable from per-request <code>feeOffered</code> alone.
        Only days that bundled at least one MRC are returned.
      </Typography>
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>days</code>: window length</>}
            secondary="Default 30, max 365."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mrc-requests/staker-take?days=30'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "mrc_staker_take",
    "id": "last_30d",
    "attributes": {
      "days": 30,
      "samples": [
        { "ts": 1773014400, "stakerTotal": "0.00821205",
          "foundationTotal": "0.00272402", "mrcBlocks": 1 }
      ]
    }
  }
}`}
      />
    </Box>
  );
}
