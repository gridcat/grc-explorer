import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';

export function Errors() {
  return (
    <Box id="errors" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Errors
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Errors are returned with the appropriate HTTP status code and a
        JSON:API <code>errors</code> array. Successful responses never
        include this array; errors never include a <code>data</code>{' '}
        field.
      </Typography>
      <CodeBlock
        caption="Response — 404 Not Found"
        language="json"
        code={`{
  "errors": [
    {
      "status": 404,
      "title": "Block not found"
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" sx={{ pt: 2, pb: 1 }}>
        Common status codes
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText primary="200 OK" secondary="Successful read." />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary="302 Found" secondary="Used by hash-lookup endpoints to redirect to the canonical resource (e.g. /blocks/hash/:hash → /blocks/:height)." />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="400 Bad Request"
            secondary="A query parameter failed validation. Common causes: malformed cohort string, non-integer page size, unsupported granularity."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="404 Not Found"
            secondary="The requested resource does not exist."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="429 Too Many Requests"
            secondary="Rate limit exhausted. Retry-After header indicates how long until your bucket refills."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="503 Service Unavailable"
            secondary="The indexer or its wallet RPC is unreachable. Transient. Retry with backoff."
          />
        </ListItem>
      </List>
    </Box>
  );
}
