import {
  Alert, Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { IS_TESTNET } from '../../../lib/network';
import { API_BASE, MAINNET_API_BASE, TESTNET_API_BASE } from './apiBase';

export function Overview() {
  return (
    <Box id="overview" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Overview
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        The Gridcoin Explorer exposes a public, no-auth, read-only JSON:API
        covering every block, transaction, address, claim, superblock, poll
        and beacon the indexer has observed. The same data drives the web
        dashboard you are looking at. Anything visible in the UI is
        available to your code at one of the endpoints below.
      </Typography>

      <Typography variant="h6" component="h3" sx={{ pt: 2, pb: 1 }}>
        Base URLs
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><strong>Mainnet:</strong> <code>{MAINNET_API_BASE}</code></>}
            secondary="The canonical Gridcoin chain."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><strong>Testnet:</strong> <code>{TESTNET_API_BASE}</code></>}
            secondary="A separate stack indexing the Gridcoin testnet wallet. Same shape, separate data."
          />
        </ListItem>
      </List>
      <Typography gutterBottom variant="body1" component="p">
        The two stacks are isolated; the testnet API will never return mainnet
        data and vice versa. The active stack identifies itself in the {' '}
        <code>meta.network</code> field of every response.
      </Typography>

      <Typography variant="h6" component="h3" sx={{ pt: 2, pb: 1 }}>
        Quick test
      </Typography>
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
      "network": "${IS_TESTNET ? 'testnet' : 'mainnet'}",
      "indexer": {
      "status": "live",
      "lastIndexedHeight": 89281,
      "lastIndexedHash": "a5296f58a974...",
      "tipHeight": 89281
      }
    }
  },
  "meta": { "network": "${IS_TESTNET ? 'testnet' : 'mainnet'}", "version": "1.0.0" }
}`}
      />

      <Typography variant="h6" component="h3" sx={{ pt: 2, pb: 1 }}>
        Authentication
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        None. The API is read-only and public; sending an
        {' '}<code>Authorization</code>{' '} header has no effect.
      </Typography>

      <Typography variant="h6" component="h3" sx={{ pt: 2, pb: 1 }}>
        Rate limits
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Per-IP, 60-second sliding window:
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText primary="Reads: 1800 / minute" secondary="Every endpoint listed below counts toward this bucket." />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary="Search: 300 / minute" secondary="Limit on the federated /search endpoint specifically." />
        </ListItem>
      </List>
      <Alert severity="info" variant="outlined" sx={{ my: 2 }}>
        Limits are intentionally generous for a dashboard reading a few
        dozen endpoints on first paint. If you have a use case that needs
        more, get in touch.
      </Alert>
    </Box>
  );
}
