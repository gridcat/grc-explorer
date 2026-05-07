import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Superblocks() {
  return (
    <Box id="superblocks" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Superblocks
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Gridcoin&apos;s superblocks anchor the magnitude payouts. Every
        superblock height carries a quorum hash and the full per-CPID
        magnitude table.
      </Typography>

      <Typography variant="h6" component="h3" id="superblocks-list" sx={{ pt: 2, pb: 1 }}>
        List
      </Typography>
      <Endpoint method="GET" path="/api/superblocks" title="Newest first" />
      <Typography gutterBottom variant="body1" component="p">
        Paginated. Returns the same headline counters that the dashboard
        superblocks page consumes.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/superblocks?page[size]=20'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 1234 },
  "data": [
    {
      "type": "superblocks",
      "id": "89000",
      "attributes": {
        "height": 89000,
        "quorumHash": "ab12cd34...",
        "totalMagnitude": 1235.5,
        "cpidCount": 421,
        "projectCount": 12
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="superblocks-get" sx={{ pt: 2, pb: 1 }}>
        Get one
      </Typography>
      <Endpoint method="GET" path="/api/superblocks/:height" title="With magnitude table" />
      <Typography gutterBottom variant="body1" component="p">
        Returns the superblock plus the full <code>cpid → magnitude</code>{' '}
        table. Large CPID counts (mainnet superblocks may carry several
        thousand entries), so pull on demand only, not on every page load.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/superblocks/89000'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "superblocks",
    "id": "89000",
    "attributes": {
      "height": 89000,
      "quorumHash": "ab12cd34...",
      "totalMagnitude": 1235.5,
      "cpidCount": 421,
      "projectCount": 12,
      "payloadSize": 6543
    }
  },
  "magnitudes": [
    { "cpid": "ab12...c34d", "magnitude": 12.34 },
    { "cpid": "ef56...7890", "magnitude": 11.21 }
  ]
}`}
      />
    </Box>
  );
}
