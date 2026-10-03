import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Addresses() {
  return (
    <Box id="addresses" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Addresses
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Per-address running balances, transaction history, and UTXO set.
        The list endpoint is the rich-list view (top-N by current
        balance).
      </Typography>

      <Typography variant="h6" component="h3" id="addresses-list" sx={{ pt: 2, pb: 1 }}>
        Rich list
      </Typography>
      <Endpoint method="GET" path="/api/addresses" title="Sorted by balance desc" />
      <Typography gutterBottom variant="body1" component="p">
        Default <code>page[size]=100</code>, max 1000. The{' '}
        <code>addresses</code> table carries an index on
        {' '}<code>balance DESC</code> so this is a cheap top-N read
        regardless of total row count.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/addresses?page[size]=10'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 12345, "network": "mainnet", "version": "1.0.0" },
  "data": [
    {
      "type": "addresses",
      "id": "S6XqhSVj...",
      "attributes": {
        "address": "S6XqhSVj...",
        "balance": "1234.56789012",
        "totalReceived": "5000.00000000",
        "totalSent": "3765.43210988",
        "txCount": 42,
        "firstSeenBlock": 12345,
        "lastSeenBlock": 89281
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="addresses-get" sx={{ pt: 2, pb: 1 }}>
        Get an address
      </Typography>
      <Endpoint method="GET" path="/api/addresses/:address" title="Balance + counters" />
      <Typography gutterBottom variant="body1" component="p">
        Returns the current-state mirror plus a{' '}
        <code>pendingBalance</code> derived from the live mempool.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/addresses/S6XqhSVj4eSAoRshrYVcCcdtdqejZ7nApu'`}
      />
      <CodeBlock
        caption="Response — 200 OK"
        language="json"
        code={`{
  "data": {
    "type": "addresses",
    "id": "S6XqhSVj...",
    "attributes": {
      "address": "S6XqhSVj...",
      "balance": "1234.56789012",
      "totalReceived": "5000.00000000",
      "totalSent": "3765.43210988",
      "txCount": 42,
      "firstSeenBlock": 12345,
      "lastSeenBlock": 89281
    }
  },
  "pendingBalance": "0.50000000"
}`}
      />

      <Typography variant="h6" component="h3" id="addresses-tx" sx={{ pt: 2, pb: 1 }}>
        Transaction history
      </Typography>
      <Endpoint method="GET" path="/api/addresses/:address/transactions" title="Per-tx deltas" />
      <Typography gutterBottom variant="body1" component="p">
        Paginated, newest-first. Each row carries the net delta this
        address experienced in that transaction; <code>ts</code> is the
        transaction time. <code>meta.count</code> is the number of rows on
        this page, not a total.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/addresses/S6XqhSVj4eSAoRshrYVcCcdtdqejZ7nApu/transactions?page[size]=25'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 25 },
  "data": [
    {
      "type": "address_tx",
      "id": "S6XqhSVj4eSAoRshrYVcCcdtdqejZ7nApu:3300495:966a37a117...",
      "attributes": {
        "txId": "966a37a117838b117bf23240ffb8d7206f1dd85214bc82505aff6d3a7c14f826",
        "height": 3300495,
        "delta": "189.16587624",
        "ts": 1791028480
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="addresses-blocks" sx={{ pt: 2, pb: 1 }}>
        Blocks staked
      </Typography>
      <Endpoint method="GET" path="/api/addresses/:address/blocks" title="Paginated" />
      <Typography gutterBottom variant="body1" component="p">
        One row per block this address staked, newest first (
        <code>?sort=height</code> for oldest first), with the subsidy and
        magnitude from the block&apos;s claim.{' '}
        <code>stakerCpid</code> is the CPID the block was staked under, or{' '}
        <code>null</code> for an investor stake. <code>meta.count</code> is
        the total number of blocks the address has staked.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl -g '${API_BASE}/addresses/S6XqhSVj4eSAoRshrYVcCcdtdqejZ7nApu/blocks?page[size]=25'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "meta": { "count": 31281 },
  "data": [
    {
      "type": "blocks",
      "id": "3300469",
      "attributes": {
        "height": 3300469,
        "hash": "9be1f7efb9414c6804e1f4e252f1fe38e0034c87e0c04e6d9c034b157c5a6a05",
        "time": 1791026160,
        "isSuperblock": false,
        "stakerCpid": "f73c4a99a56b68e4b0c649e2cef6bde7",
        "researchSubsidy": "120.5015175",
        "blockSubsidy": "76.29373193",
        "magnitude": 23387
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="addresses-utxos" sx={{ pt: 2, pb: 1 }}>
        UTXOs
      </Typography>
      <Endpoint method="GET" path="/api/addresses/:address/utxos" title="Unspent outputs" />
      <Typography gutterBottom variant="body1" component="p">
        Returns every output for this address where{' '}
        <code>spent_in_height IS NULL</code>.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/addresses/S6XqhSVj4eSAoRshrYVcCcdtdqejZ7nApu/utxos'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": [
    {
      "type": "utxos",
      "id": "56886c5134...:1",
      "attributes": {
        "txId": "56886c5134...",
        "voutN": 1,
        "value": "100.00000000",
        "blockHeight": 89281,
        "scriptType": "pubkeyhash"
      }
    }
  ]
}`}
      />
    </Box>
  );
}
