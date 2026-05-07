import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Metrics() {
  return (
    <Box id="metrics" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Metrics
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Pre-aggregated rollups for the dashboard charts. Every endpoint
        here reads from a manually-maintained table, so a chart that
        would otherwise scan every transaction is just an indexed lookup.
      </Typography>

      <Typography variant="h6" component="h3" id="metrics-buckets" sx={{ pt: 2, pb: 1 }}>
        Bucketed time series
      </Typography>
      <Endpoint method="GET" path="/api/metrics" title="Funds-flow / tx-count chart" />
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>granularity</code></>}
            secondary='"5min" or "1h" (default "5min"). Indexer maintains 1d/1w/1mo buckets too; query directly for those if needed.'
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>hours</code>: window</>}
            secondary="Default 12, max 168."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics?granularity=1h&hours=24'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "metric_buckets",
    "id": "1h:24h",
    "attributes": {
      "granularity": "1h", "hours": 24,
      "from": 1775828000, "to": 1775914000,
      "points": [
      { "bucketTs": 1775828400, "txCount": 32,
        "valueMoved": "12345.67890000", "feeTotal": "0.00210000" },
      { "bucketTs": 1775832000, "txCount": 41,
        "valueMoved": "23456.78900000", "feeTotal": "0.00280000" }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-leaderboard-magnitude" sx={{ pt: 2, pb: 1 }}>
        Magnitude leaderboard with sparklines
      </Typography>
      <Endpoint method="GET" path="/api/metrics/leaderboard/magnitude" title="Top-N + history" />
      <Typography gutterBottom variant="body1" component="p">
        Top researchers by current magnitude, each with a 14-superblock
        sparkline.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/leaderboard/magnitude?limit=20'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": [
    {
      "type": "magnitude_leaderboard",
      "id": "ab12...c34d",
      "attributes": {
        "cpid": "ab12...c34d",
        "magnitude": 124.5,
        "rank": 1,
        "history": [120.0, 122.5, 124.5]
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-research-split" sx={{ pt: 2, pb: 1 }}>
        Research / block reward split
      </Typography>
      <Endpoint method="GET" path="/api/metrics/research-split" title="Last N hours" />
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/research-split?hours=168'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "research_split",
    "id": "168h",
    "attributes": {
      "hours": 168,
      "blockReward": "1234.50000000",
      "researchReward": "5678.90000000",
      "researchShare": 0.821
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-beacon-flux" sx={{ pt: 2, pb: 1 }}>
        Beacon flux
      </Typography>
      <Endpoint method="GET" path="/api/metrics/beacon-flux" title="Active / new / expired counts" />
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/beacon-flux'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "beacon_flux",
    "id": "now",
    "attributes": {
      "active": 421,
      "newLast24h": 3,
      "expiringNext24h": 5,
      "expiredLast24h": 2,
      "supersededLast24h": 1
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-staker-mix" sx={{ pt: 2, pb: 1 }}>
        Researcher vs investor staking
      </Typography>
      <Endpoint method="GET" path="/api/metrics/staker-mix" title="Last N blocks ratio" />
      <Typography gutterBottom variant="body1" component="p">
        <code>blocks</code> default 1000, min 100, max 10000.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/staker-mix?blocks=1000'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "staker_mix",
    "id": "blocks=1000",
    "attributes": {
      "blocks": 1000,
      "researchers": 712,
      "investors": 288,
      "researcherShare": 0.712
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-fee-percentiles" sx={{ pt: 2, pb: 1 }}>
        Fee percentiles
      </Typography>
      <Endpoint method="GET" path="/api/metrics/fee-percentiles" title="p50 / p95 / p99 over time" />
      <Typography gutterBottom variant="body1" component="p">
        Reads pre-computed <code>fee_percentiles</code> rows maintained
        by FeePercentileJob. Granularity:{' '}
        <code>5min</code> | <code>1h</code> | <code>1d</code>; window via
        <code> hours</code> (default 24, max 168).
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/fee-percentiles?granularity=1h&hours=24'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "fee_percentiles_series",
    "id": "1h:24h",
    "attributes": {
      "granularity": "1h", "hours": 24,
      "from": 1775830000, "to": 1775914000,
      "points": [
      { "bucketTs": 1775830800, "p50": "1024", "p95": "5400", "p99": "12000", "txCount": 14 },
      { "bucketTs": 1775834400, "p50": "1100", "p95": "5800", "p99": "13500", "txCount": 11 }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-wealth" sx={{ pt: 2, pb: 1 }}>
        Wealth distribution
      </Typography>
      <Endpoint method="GET" path="/api/metrics/wealth-distribution" title="Snapshot" />
      <Endpoint method="GET" path="/api/metrics/wealth-distribution/series" title="Time series" />
      <Typography gutterBottom variant="body1" component="p">
        Gini coefficient and top-1% / top-10% / top-100 concentration
        shares. Snapshots are written daily by{' '}
        <code>WealthSnapshotJob</code>; the series endpoint accepts{' '}
        <code>from</code> and <code>to</code> unix-seconds (defaults to
        last 365 days).
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`# Snapshot
curl '${API_BASE}/metrics/wealth-distribution'

# Time series, last 90 days
curl '${API_BASE}/metrics/wealth-distribution/series?from=1768262400'`}
      />
      <CodeBlock
        caption="Response — 200 OK (snapshot, excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "wealth_distribution",
    "id": "now",
    "attributes": {
      "ts": 1775914000,
      "addressesWithBalance": 12345,
      "totalSupply": "123456789.00000000",
      "gini": "0.7421",
      "top1pctShare": "0.4520",
      "top10pctShare": "0.7800",
      "top100Share": "0.5210"
    }
  }
}`}
      />
      <CodeBlock
        caption="Response — 200 OK (series, excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "wealth_distribution_series",
    "id": "from=1768262400",
    "attributes": {
      "from": 1768262400, "to": 1775914000,
      "points": [
      { "ts": 1768262400, "gini": "0.7401",
        "top1pctShare": "0.4500", "top10pctShare": "0.7780" },
      { "ts": 1768348800, "gini": "0.7405",
        "top1pctShare": "0.4510", "top10pctShare": "0.7790" }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-cohort-retention" sx={{ pt: 2, pb: 1 }}>
        CPID cohort retention
      </Typography>
      <Endpoint method="GET" path="/api/metrics/cpid-cohort-retention" title="Per-cohort curve" />
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText primary={<><code>cohort</code> (required)</>} secondary="YYYY-MM. The month CPIDs were first seen claiming." />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary={<><code>horizon</code></>} secondary="Months forward to follow. Default 12, max 36." />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/cpid-cohort-retention?cohort=2024-01&horizon=12'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "cpid_cohort_retention",
    "id": "2024-01:12",
    "attributes": {
      "cohort": "2024-01",
      "horizon": 12,
      "cohortSize": 87,
      "points": [
      { "monthOffset": 0, "bucketTs": 1704067200, "active": 87 },
      { "monthOffset": 1, "bucketTs": 1706745600, "active": 71 },
      { "monthOffset": 2, "bucketTs": 1709251200, "active": 64 }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="metrics-beacon-survival" sx={{ pt: 2, pb: 1 }}>
        Beacon survival funnel
      </Typography>
      <Endpoint method="GET" path="/api/metrics/beacon-survival" title="Cohort survival" />
      <Typography gutterBottom variant="body1" component="p">
        For each cohort month: how many beacons advertised, confirmed,
        renewed, expired. Computed from the full beacon table; currently
        covers the last 12 cohort months.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/beacon-survival'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": [
    {
      "type": "beacon_survival",
      "id": "2024-01",
      "attributes": {
        "cohort": "2024-01",
        "advertised": 12,
        "confirmed": 11,
        "renewed": 9,
        "expired": 2
      }
    }
  ]
}`}
      />
    </Box>
  );
}
