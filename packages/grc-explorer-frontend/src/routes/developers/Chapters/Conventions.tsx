import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';

export function Conventions() {
  return (
    <Box id="conventions" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Conventions
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Every endpoint follows the same envelope, query-parameter shape and
        unit conventions. Read this section once and the rest of the
        reference is repetition.
      </Typography>

      <Typography variant="h6" component="h3" id="conventions-envelope" sx={{ pt: 2, pb: 1 }}>
        Response envelope
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Single resources return a single <code>data</code> object;
        collections return a <code>data</code> array. Both shapes carry a
        <code> meta </code> object at the top level. List endpoints
        include <code>meta.count</code> with the total matching record
        count, and every response includes <code>meta.network</code> and
        <code> meta.version</code>.
      </Typography>
      <CodeBlock
        caption="Single resource"
        language="json"
        code={`{
  "data": {
    "type": "blocks",
    "id": "89281",
    "attributes": { /* ... */ }
  },
  "meta": { "network": "testnet", "version": "1.0.0" }
}`}
      />
      <CodeBlock
        caption="Collection"
        language="json"
        code={`{
  "data": [
    { "type": "blocks", "id": "89281", "attributes": { /* ... */ } },
    { "type": "blocks", "id": "89280", "attributes": { /* ... */ } }
  ],
  "meta": { "count": 89282, "network": "testnet", "version": "1.0.0" }
}`}
      />

      <Typography variant="h6" component="h3" id="conventions-pagination" sx={{ pt: 2, pb: 1 }}>
        Pagination
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>page[size]</code>: items per page</>}
            secondary="Default 25, maximum 100. Values above 100 are silently capped."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>page[number]</code>: zero-indexed page number</>}
            secondary="Offset is computed as page[number] × page[size]."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>page[offset]</code>: absolute record offset</>}
            secondary="Skip N records before returning results. Mutually exclusive with page[number]."
          />
        </ListItem>
      </List>

      <Typography variant="h6" component="h3" id="conventions-sorting" sx={{ pt: 2, pb: 1 }}>
        Sorting
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        List endpoints accept a <code>sort=field</code> parameter for
        ascending order or <code>sort=-field</code> for descending.
        Unspecified sort falls back to the natural order documented per
        endpoint (typically newest-first by height or timestamp).
      </Typography>

      <Typography variant="h6" component="h3" id="conventions-amounts" sx={{ pt: 2, pb: 1 }}>
        Amounts and units
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary="GRC strings"
            secondary={<>Returned as decimal strings (e.g. <code>&quot;12.34567890&quot;</code>) to keep precision intact across JSON. Never parse with parseFloat into a hot calculation; treat as strings or use a BigNumber library.</>}
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="Halford"
            secondary={<>Some lower-level fields (notably percentile responses, raw-tx fee fields) ship as halford: the integer count of one hundred-millionths of a GRC (1 GRC = 100,000,000 halford). Divide by 100,000,000 for GRC, or compare halford-to-halford directly.</>}
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="Timestamps"
            secondary={<>Block / claim / beacon timestamps are Unix seconds (Number). Mempool timestamps are Unix seconds. The web frontend formats these locally; the API never returns ISO strings for these fields.</>}
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="Heights and txids"
            secondary={<>Heights are integers. Block hashes and tx ids are 64-character lowercase hex.</>}
          />
        </ListItem>
      </List>
    </Box>
  );
}
