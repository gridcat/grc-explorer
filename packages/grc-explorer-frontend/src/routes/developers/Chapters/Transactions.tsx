import { Box, Typography } from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function Transactions() {
  return (
    <Box id="transactions" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
      Transactions
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Transaction detail with resolved input addresses, output values,
        and confirmation status.
      </Typography>

      <Typography variant="h6" component="h3" id="transactions-get" sx={{ pt: 2, pb: 1 }}>
        Get a transaction
      </Typography>
      <Endpoint method="GET" path="/api/transactions/:tx_id" title="With resolved vins" />
      <Typography gutterBottom variant="body1" component="p">
        Vin entries are joined against{' '}
        <code>tx_outputs</code> on the indexer side so each input arrives
        with its source address and value already resolved. No extra
        round-trips needed for &quot;who sent this&quot;.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/transactions/56886c5134ace2589d8cd0d49a61c8b6f6ca9e7135636bf76956537a9602a222'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "transactions",
    "id": "56886c5134ace2589d8cd0d49a61c8b6f6ca9e7135636bf76956537a9602a222",
    "attributes": {
      "txId": "56886c5134...",
      "blockHeight": 89281,
      "time": 1775914221,
      "size": 224,
      "fee": "0.00010000",
      "totalIn": "100.00000000",
      "totalOut": "99.99990000",
      "isCoinbase": false,
      "isCoinstake": true,
      "vins": [
      { "vinN": 0, "prevTx": "ab12...", "prevVout": 1,
        "address": "S6XqhSVj...", "value": "100.00000000" }
      ],
      "vouts": [
      { "voutN": 0, "value": "0.00000000", "address": null,
        "scriptType": "nonstandard", "isSpent": false, "spentInTx": null },
      { "voutN": 1, "value": "99.99990000", "address": "S6XqhSVj...",
        "scriptType": "pubkey", "isSpent": false, "spentInTx": null }
      ],
      "mrc": null,
      "confirmations": 5
    }
  }
}`}
      />
      <Typography gutterBottom variant="body1" component="p">
        When the transaction is an MRC request, the response carries an
        <code> mrc</code> object alongside <code>vins</code> /{' '}
        <code>vouts</code> with the request&apos;s parsed contract
        body — <code>cpid</code>, <code>researchSubsidy</code>,
        <code> feeOffered</code>, <code>magnitude</code>,
        <code> lastBlockHash</code>, <code>signature</code>,
        <code> firstSeen</code>, <code>blockHeight</code> /{' '}
        <code>blockTime</code> when confirmed. <code>null</code> for
        non-MRC txs.
      </Typography>

      <Typography gutterBottom variant="body1" component="p" sx={{ pt: 1 }}>
        Lookup tiers: indexed transactions table, then mempool. Random
        / unknown txids return 404; <code>tx_id</code> must be 64
        lowercase hex characters or the request 400s at the edge.
      </Typography>

      <Typography variant="h6" component="h3" id="transactions-raw" sx={{ pt: 2, pb: 1 }}>
        Raw transaction
      </Typography>
      <Endpoint method="GET" path="/api/transactions/:tx_id/raw" title="Hex + decoded" />
      <Typography gutterBottom variant="body1" component="p">
        Returns the raw hex serialization plus the daemon&apos;s decoded
        JSON for the transaction. This call is lazy: it hits the wallet
        daemon on demand rather than serving from the indexer cache, so
        it can be slower than other reads. Script ASMs are cleaned up to
        fix the daemon&apos;s decimal-encoding of small data pushes.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/transactions/56886c5134ace2589d8cd0d49a61c8b6f6ca9e7135636bf76956537a9602a222/raw'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "raw_transactions",
    "id": "56886c5134...",
    "attributes": {
      "hex": "0100000001ab12...",
      "decoded": { "txid": "56886c5134...", "vin": [/*...*/], "vout": [/*...*/] }
    }
  }
}`}
      />
    </Box>
  );
}
