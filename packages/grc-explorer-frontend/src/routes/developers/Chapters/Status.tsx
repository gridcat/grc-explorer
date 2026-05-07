import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Status() {
  return (
    <Box id="status" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Status
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Health, version, and indexer cursor. Useful for client-side
        backoff: <code>indexer.tipHeight - indexer.lastIndexedHeight</code>{' '}
        tells you how far behind the chain tip the explorer currently is.
      </Typography>

      <Endpoint method="GET" path="/api/status" title="Service health" />
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/status'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "data": {
    "type": "status",
    "id": "now",
    "attributes": {
      "service": "grc-explorer",
      "version": "1.0.0",
      "network": "testnet",
      "indexer": {
      "status": "live",
      "lastIndexedHeight": 89281,
      "lastIndexedHash": "a5296f58a974...",
      "tipHeight": 89281,
      "reorgDepth": 0
      }
    }
  }
}`}
      />
      <Typography gutterBottom variant="body1" component="p" sx={{ color: 'text.secondary' }}>
        <code>indexer.status</code> is one of <code>backfilling</code>,{' '}
        <code>live</code>, or <code>reorg</code>.
      </Typography>
    </Box>
  );
}
