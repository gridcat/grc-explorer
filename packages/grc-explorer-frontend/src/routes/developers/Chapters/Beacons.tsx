import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Beacons() {
  return (
    <Box id="beacons" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Beacons
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Beacon advertisements link a CPID to an address. Each beacon row
        carries{' '}
        <code>block_height</code>, <code>expiration</code>, and a
        <code> superseded_at_height</code> sentinel that closes the row
        when a newer beacon for the same CPID lands.
      </Typography>

      <Typography variant="h6" component="h3" id="beacons-cpid" sx={{ pt: 2, pb: 1 }}>
        Beacon history
      </Typography>
      <Endpoint method="GET" path="/api/beacons/:cpid" title="Full history per CPID" />
      <Typography gutterBottom variant="body1" component="p">
        Status is derived on read:
      </Typography>
      <CodeBlock
        caption="Status logic"
        code={`if status === "revoked"            -> "revoked"
else if superseded_at_height set    -> "superseded"
else if expiration > evalTime       -> "active"
else                                -> "expired"`}
      />
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/beacons/ab12cd34ef567890ab12cd34ef567890'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": [
    {
      "type": "beacons",
      "id": "56886c5134...",
      "attributes": {
        "cpid": "ab12cd34ef567890ab12cd34ef567890",
        "address": "S6XqhSVj...",
        "blockHeight": 88000,
        "time": 1773000000,
        "expiration": 1791000000,
        "supersededAtHeight": null,
        "status": "active"
      }
    }
  ]
}`}
      />
    </Box>
  );
}
