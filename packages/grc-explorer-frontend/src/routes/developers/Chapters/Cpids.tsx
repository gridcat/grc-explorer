import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Cpids() {
  return (
    <Box id="cpids" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      CPIDs
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Researcher views: claim history, magnitude over time, beacon
        records, and blocks staked.
      </Typography>

      <Typography variant="h6" component="h3" id="cpids-get" sx={{ pt: 2, pb: 1 }}>
        Researcher detail
      </Typography>
      <Endpoint method="GET" path="/api/cpids/:cpid" title="Aggregate view" />
      <Typography gutterBottom variant="body1" component="p">
        Bundles claims (last 50), magnitudes (last 100 superblocks),
        beacons, and the count of blocks staked by this CPID.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/cpids/ab12cd34ef567890ab12cd34ef567890'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "cpids",
    "id": "ab12cd34ef567890ab12cd34ef567890",
    "attributes": {
      "cpid": "ab12cd34ef567890ab12cd34ef567890",
      "magnitude": 12.34,
      "blocksStaked": 87,
      "lastSeenBlock": 89281
    }
  },
  "claims": [
    { "blockHeight": 89281, "researchSubsidy": "5.00000000",
      "magnitude": 12.34, "isMrc": false }
  ],
  "magnitudes": [
    { "superblockHeight": 89000, "magnitude": 12.34 }
  ],
  "beacons": [
    { "blockHeight": 88000, "address": "S6XqhSVj...",
      "expiration": 1791000000, "status": "active" }
  ],
  "mrcs": [
    { "txId": "4f0d7710...", "researchSubsidy": "1228.01",
      "feeOffered": "0.01093607", "firstSeen": 1776612237,
      "blockHeight": 3154442, "blockTime": 1776612240,
      "status": "confirmed", "waitSeconds": 3 }
  ]
}`}
      />
      <Typography gutterBottom variant="body1" component="p">
        <code>mrcs</code> carries this CPID&apos;s MRC request history
        (last 100, newest first). <code>status</code> is{' '}
        <code>pending</code> | <code>confirmed</code> | <code>evicted</code>;
        <code> waitSeconds</code> is <code>blockTime − firstSeen</code> for
        confirmed requests we observed enter mempool, <code>null</code>
        otherwise.
      </Typography>

      <Typography variant="h6" component="h3" id="cpids-blocks" sx={{ pt: 2, pb: 1 }}>
        Blocks staked
      </Typography>
      <Endpoint method="GET" path="/api/cpids/:cpid/blocks" title="Paginated" />
      <Typography gutterBottom variant="body1" component="p">
        One row per block this CPID staked, joined to the matching claim
        for subsidy + magnitude. Newest-first.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/cpids/ab12cd34ef567890ab12cd34ef567890/blocks?page[size]=25'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 87 },
  "data": [
    {
      "type": "cpid_blocks",
      "id": "89281",
      "attributes": {
        "blockHeight": 89281,
        "time": 1775914221,
        "researchSubsidy": "5.00000000",
        "magnitude": 12.34,
        "isMrc": false
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="cpids-leaderboard" sx={{ pt: 2, pb: 1 }}>
        Leaderboard with rank-delta
      </Typography>
      <Endpoint method="GET" path="/api/cpids/leaderboard" title="Top-N + Δ" />
      <Typography gutterBottom variant="body1" component="p">
        Top researchers by current magnitude with an optional rank delta
        against an earlier moment. Powers the dashboard&apos;s {' '}
        <code>↑3 / ↓7 / NEW</code> column.
      </Typography>
      <Typography variant="subtitle2" component="h4" sx={{ pt: 1, pb: 0.5 }}>
        Query parameters
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>limit</code>: top-N size</>}
            secondary="Default 20, max 100."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>at</code>: anchor for &quot;current&quot;</>}
            secondary='Default = latest indexed superblock. Allows historical leaderboards.'
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>compare_at</code>: delta anchor</>}
            secondary='Unix-seconds. Each row gets rankThen / rankDelta / isNew computed against the leaderboard at that moment.'
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/cpids/leaderboard?limit=20&compare_at=1773408000'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "data": [
    {
      "type": "cpid_leaderboard",
      "id": "ab12...c34d",
      "attributes": {
      "cpid": "ab12...c34d",
      "rank": 1,
      "magnitude": 124.5,
      "rankThen": 4,
      "rankDelta": 3,
      "isNew": false
      }
    },
    {
      "type": "cpid_leaderboard",
      "id": "ef56...7890",
      "attributes": {
      "cpid": "ef56...7890",
      "rank": 2,
      "magnitude": 110.0,
      "rankThen": null,
      "rankDelta": null,
      "isNew": true
      }
    }
  ],
  "meta": {
    "currentSuperblockHeight": 89000,
    "compareSuperblockHeight": 85800,
    "limit": 20
  }
}`}
      />
    </Box>
  );
}
