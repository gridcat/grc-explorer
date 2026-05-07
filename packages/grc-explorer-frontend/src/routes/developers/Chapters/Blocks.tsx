import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Blocks() {
  return (
    <Box id="blocks" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Blocks
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Block headers and aggregate metadata. Heights are 0-indexed; hash
        is the standard double-SHA256 block hash returned as 64 lowercase
        hex chars.
      </Typography>

      <Typography variant="h6" component="h3" id="blocks-list" sx={{ pt: 2, pb: 1 }}>
        List blocks
      </Typography>
      <Endpoint method="GET" path="/api/blocks" title="Newest first" />
      <Typography gutterBottom variant="body1" component="p">
        Default sort is <code>-height</code>. Supports the common
        {' '}<code>page[size]</code>{' '}and{' '}
        <code>page[number]</code>{' '}parameters.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/blocks?page[size]=2'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "meta": { "count": 89282 },
  "data": [
    {
      "type": "blocks",
      "id": "89281",
      "attributes": {
      "height": 89281,
      "hash": "a5296f58a974686e7356da9b5931650b9fdfbf77958a125489b663a7c074d438",
      "prevHash": "16b6ec49ad073391...",
      "time": 1775914221,
      "txCount": 1,
      "isPos": true,
      "isSuperblock": false,
      "minerAddress": "S6XqhSVj...",
      "stakerCpid": "ab12...c34d"
      }
    },
    {
      "type": "blocks",
      "id": "89280",
      "attributes": { /* ... */ }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="blocks-get" sx={{ pt: 2, pb: 1 }}>
        Get a block by height
      </Typography>
      <Endpoint method="GET" path="/api/blocks/:height" title="Block detail" />
      <Typography gutterBottom variant="body1" component="p">
        Returns the block plus embedded transactions and (for staking
        blocks) the claim payload, the same shape the dashboard&apos;s
        block detail page consumes.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/blocks/89281'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "blocks",
    "id": "89281",
    "attributes": {
      "height": 89281,
      "hash": "a5296f58a974...",
      "prevHash": "16b6ec49ad07...",
      "merkleRoot": "fa01b3...",
      "time": 1775914221,
      "version": 13,
      "difficulty": "0.18272300",
      "size": 412,
      "txCount": 1,
      "isPos": true,
      "isSuperblock": false,
      "minerAddress": "S6XqhSVj...",
      "stakerCpid": "ab12...c34d",
      "mint": "5.00000000",
      "moneySupply": "123456789.00000000"
    }
  },
  "transactions": [
    { "txId": "56886c5134...", "isCoinbase": false, "isCoinstake": true,
      "totalOut": "5.00000000", "fee": "0.00000000" }
  ],
  "claim": { "cpid": "ab12...c34d", "organization": "world community grid",
             "client_version": "5.4.10.0", "block_subsidy": "0",
             "research_subsidy": "5.00000000", "magnitude": 12.34, "is_mrc": false },
  "mrcs": [],
  "tipHeight": 89281,
  "meta": { "network": "testnet", "version": "1.0.0" }
}`}
      />

      <Typography variant="h6" component="h3" id="blocks-hash" sx={{ pt: 2, pb: 1 }}>
        Lookup by hash
      </Typography>
      <Endpoint method="GET" path="/api/blocks/hash/:hash" title="302 redirect" />
      <Typography gutterBottom variant="body1" component="p">
        Redirects to the canonical{' '}
        <code>/api/blocks/:height</code> URL. Useful when you have a hash
        from a logging system or chain analysis tool. Pass <code>-L</code>{' '}
        so curl follows the redirect for you.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -L '${API_BASE}/blocks/hash/a5296f58a974686e7356da9b5931650b9fdfbf77958a125489b663a7c074d438'`}
      />
    </Box>
  );
}
