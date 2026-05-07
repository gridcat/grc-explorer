import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Mempool() {
  return (
    <Box id="mempool" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Mempool
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Every mempool entry carries <code>firstSeen</code>,{' '}
        <code>confirmedAt</code>, and <code>evictedAt</code> timestamps.
      </Typography>

      <Typography variant="h6" component="h3" id="mempool-snapshot" sx={{ pt: 2, pb: 1 }}>
        Snapshot
      </Typography>
      <Endpoint method="GET" path="/api/mempool" title="Current pending tx set" />
      <Typography gutterBottom variant="body1" component="p">
        Active mempool = txs where neither <code>confirmedAt</code> nor
        <code> evictedAt</code> is set.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/mempool?page[size]=100'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 4 },
  "data": [
    {
      "type": "mempool_txs",
      "id": "56886c5134...",
      "attributes": {
        "txId": "56886c5134...",
        "firstSeen": 1775914000,
        "feeEstimate": "0.00010000",
        "size": 224,
        "vinCount": 1,
        "voutCount": 2
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="mempool-fee-histogram" sx={{ pt: 2, pb: 1 }}>
        Fee histogram
      </Typography>
      <Endpoint method="GET" path="/api/mempool/fee-histogram" title="Pending tx fee distribution" />
      <Typography gutterBottom variant="body1" component="p">
        Bucketed by fee-per-KB (halford). Updates every 5 seconds.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mempool/fee-histogram'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "data": {
    "type": "fee_histogram",
    "id": "now",
    "attributes": {
      "buckets": [
      { "feePerKb": 1000, "count": 14 },
      { "feePerKb": 5000, "count": 7 },
      { "feePerKb": 10000, "count": 2 }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="mempool-timeline" sx={{ pt: 2, pb: 1 }}>
        Timeline
      </Typography>
      <Endpoint method="GET" path="/api/mempool/timeline" title="Mempool size over time" />
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>hours</code>: window length</>}
            secondary="Default 6, max 168 (7 days)."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>step</code>: bucket size in seconds</>}
            secondary="Server-side downsample. 0 (default) returns one point per sample."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mempool/timeline?hours=6&step=300'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "mempool_timeline",
    "id": "6h:300s",
    "attributes": {
      "from": 1775892000, "to": 1775914000,
      "step": 300,
      "points": [
      { "ts": 1775892000, "size": 3, "feeMedian": "0.00010000" },
      { "ts": 1775895600, "size": 7, "feeMedian": "0.00012000" },
      { "ts": 1775899200, "size": 5, "feeMedian": "0.00010000" }
      ]
    }
  }
}`}
      />
    </Box>
  );
}
