import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Search() {
  return (
    <Box id="search" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Search
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Federated full-text search across blocks, transactions,
        addresses, claims, superblocks, polls, and beacons. Backed by a
        dedicated Meilisearch sidecar, drained from a Redis stream so
        the indexer can stay ahead of search updates.
      </Typography>

      <Endpoint method="GET" path="/api/search" title="Federated query" />
      <Typography gutterBottom variant="body1" component="p">
        Pass <code>q=&lt;query&gt;</code>. Limit, offset, and per-index
        filtering are forwarded to Meilisearch unchanged; see the
        Meilisearch query reference for the full surface. The response
        groups hits by index.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/search?q=worldcommunitygrid'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "search_results",
    "id": "worldcommunitygrid",
    "attributes": {
      "blocks": { "hits": [/* ... */], "estimatedTotalHits": 0 },
      "transactions": { "hits": [/* ... */], "estimatedTotalHits": 12 },
      "claims": { "hits": [/* ... */], "estimatedTotalHits": 3 },
      "superblocks": { "hits": [/* ... */], "estimatedTotalHits": 0 },
      "polls": { "hits": [/* ... */], "estimatedTotalHits": 0 },
      "addresses": { "hits": [/* ... */], "estimatedTotalHits": 0 },
      "beacons": { "hits": [/* ... */], "estimatedTotalHits": 1 }
    }
  }
}`}
      />
      <Typography gutterBottom variant="body1" component="p" sx={{ color: 'text.secondary' }}>
        Search is rate-limited to 300 / minute per IP.
      </Typography>
    </Box>
  );
}
