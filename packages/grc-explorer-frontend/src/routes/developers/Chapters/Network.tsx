import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Network() {
  return (
    <Box id="network" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Network
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Live network health (peer count, mempool size, difficulty,
        tip vs indexed-height delta) plus a 7-day rolling time series of
        the same.
      </Typography>

      <Typography variant="h6" component="h3" id="network-now" sx={{ pt: 2, pb: 1 }}>
        Current snapshot
      </Typography>
      <Endpoint method="GET" path="/api/network" title="Cached every 15s" />
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/network'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "data": {
    "type": "network_stats",
    "id": "now",
    "attributes": {
      "tipHeight": 89281,
      "tipHash": "a5296f58...",
      "indexedHeight": 89281,
      "indexerStatus": "live",
      "difficulty": "0.18272300",
      "peerCount": 18,
      "mempoolSize": 0,
      "netVersion": 70016,
      "rpcVersion": 70016
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="network-history" sx={{ pt: 2, pb: 1 }}>
        History
      </Typography>
      <Endpoint method="GET" path="/api/network/history" title="Time series" />
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>hours</code>: window length</>}
            secondary="Default 1, max 168 (7 days)."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>endAt</code>: right-edge of the window, unix-seconds</>}
            secondary='Default = now.'
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>step</code>: server-side downsample</>}
            secondary='Bucket size in seconds, mean per bucket. 0 (default) = no downsample.'
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/network/history?hours=24&step=300'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "network_history",
    "id": "24h:300s",
    "attributes": {
      "from": 1775828000, "to": 1775914000,
      "step": 300,
      "points": [
      { "ts": 1775828000, "tipHeight": 89200, "peerCount": 16,
        "mempoolSize": 0, "difficulty": "0.18120000" },
      { "ts": 1775828300, "tipHeight": 89205, "peerCount": 17,
        "mempoolSize": 1, "difficulty": "0.18180000" }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="network-difficulty" sx={{ pt: 2, pb: 1 }}>
        Difficulty history
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Per-day network difficulty across the entire indexed chain. Backed
        by a daily-bucket aggregate over <code>blocks.difficulty</code>{' '}
        (min/max/avg + first/last block of the day), so the whole-chain
        response is microseconds to compute regardless of chain length.
        Powers the <code>/network/difficulty</code> dashboard page.
      </Typography>
      <Endpoint method="GET" path="/api/network/difficulty" title="Daily aggregates" />
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>range</code>: <code>all</code> or <code>year</code></>}
            secondary={'Default "all". When "year", a single calendar year is returned and "year" must be supplied.'}
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>year</code>: four-digit year</>}
            secondary='Required when range=year. Ignored otherwise.'
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/network/difficulty?range=year&year=2024'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "difficulty_history",
    "id": "year:2024",
    "attributes": {
      "range": "year",
      "year": 2024,
      "points": [
        {
          "ts": 1704067200,
          "date": "2024-01-01",
          "min":   "0.18012400",
          "max":   "0.19884100",
          "open":  "0.18402300",
          "close": "0.19103500",
          "avg":   0.18712,
          "samples": 942
        }
      ]
    }
  }
}`}
      />
      <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
        Decimal-typed columns (<code>min</code>, <code>max</code>,{' '}
        <code>open</code>, <code>close</code>) are returned as strings so
        the long-tail precision survives JSON.parse. <code>avg</code> is
        a float (the daily sum / count divide is already lossy).{' '}
        <code>samples</code> is the block count for the day — gives a
        rough &quot;thinness&quot; signal for early-PoW days.
      </Typography>
    </Box>
  );
}
