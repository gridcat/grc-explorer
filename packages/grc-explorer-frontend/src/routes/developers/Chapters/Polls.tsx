import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Polls() {
  return (
    <Box id="polls" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Polls
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Governance polls and their tallies. Decoded from the contract
        payload at index time, so this returns rich data without any
        extra RPC round-trips.
      </Typography>

      <Typography variant="h6" component="h3" id="polls-list" sx={{ pt: 2, pb: 1 }}>
        List polls
      </Typography>
      <Endpoint method="GET" path="/api/polls" title="Paginated, optionally active-only" />
      <Typography gutterBottom variant="body1" component="p">
        Pass <code>?active=1</code> to filter to currently open polls
        (<code>end_time &gt; now</code>). Default sort is{' '}
        <code>-block_height</code>.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/polls?active=1'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 234 },
  "data": [
    {
      "type": "polls",
      "id": "646a3e84a4c5e6a8...",
      "attributes": {
        "id": "646a3e84a4c5e6a8...",
        "title": "Should the protocol upgrade to v13?",
        "blockHeight": 88000,
        "startTime": 1773000000,
        "endTime": 1775914000,
        "responseType": 1,
        "voteWeight": "magnitude",
        "active": true
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="polls-get" sx={{ pt: 2, pb: 1 }}>
        Get a poll
      </Typography>
      <Endpoint method="GET" path="/api/polls/:poll_id" title="Poll + options + tally" />
      <Typography gutterBottom variant="body1" component="p">
        Returns the poll metadata, the option list, and the current vote
        tally per option. The tally is derived on read from{' '}
        <code>votes</code>, so reorgs and late-arriving votes are
        reflected without manual recomputation.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/polls/646a3e84a4c5e6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "polls",
    "id": "646a3e84a4c5e6a8...",
    "attributes": {
      "title": "Should the protocol upgrade to v13?",
      "question": "Vote yes to enable v13 features at block 100000.",
      "blockHeight": 88000,
      "startTime": 1773000000,
      "endTime": 1775914000,
      "responseType": 1,
      "voteWeight": "magnitude",
      "active": true,
      "totalVotes": 21,
      "totalWeight": "165.50"
    }
  },
  "options": [
    { "id": 0, "label": "Yes",
      "tally": { "votes": 14, "weight": "120.50" } },
    { "id": 1, "label": "No",
      "tally": { "votes": 7, "weight": "45.00" } }
  ]
}`}
      />
    </Box>
  );
}
