import {
  Box, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import { CodeBlock } from '../../../components/CodeBlock/CodeBlock';
import { Endpoint } from '../../../components/Endpoint/Endpoint';
import { API_BASE } from './apiBase';

export function MandatorySidestakes() {
  return (
    <Box id="mandatory-sidestakes" sx={{ pb: 4 }}>
      <Typography variant="h4" component="h2" sx={{ pb: 2 }}>
        Mandatory sidestakes
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Protocol-driven allocations of a fraction of the CoinStake reward
        to designated addresses (Gridcoin Foundation etc.). Activated at
        block <strong>v13</strong> (mainnet height 3,989,800, testnet
        2,870,000). The registry is governed by signed{' '}
        <code>sidestake</code> contracts in the chain — not hardcoded —
        and the daemon enforces a 25% global cap summed across all
        active recipients, with at most 4 outputs added to any
        CoinStake transaction.
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Pre-V13, the daemon rejects sidestake contracts, so these
        endpoints return empty payloads for any explorer indexed at
        pre-V13 chain state. Post-activation they fill in within a
        block of the registry change or payout landing.
      </Typography>

      <Typography variant="h6" component="h3" id="mss-list" sx={{ pt: 2, pb: 1 }}>
        Active registry
      </Typography>
      <Endpoint method="GET" path="/api/mandatory-sidestakes" title="Currently active recipients" />
      <Typography gutterBottom variant="body1" component="p">
        Joins the registry against per-recipient payout aggregates
        (<code>totalPaid</code>, <code>payoutCount</code>) so the home
        tile and the recipients page render in one round trip. Returns
        only entries currently in <code>MANDATORY</code> state —
        deleted ones drop out automatically.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mandatory-sidestakes'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": [
    {
      "type": "mandatory_sidestakes",
      "id": "SFoundationXXXXXXXXXXXXXXXXXXXXXXX",
      "attributes": {
        "address": "SFoundationXXXXXXXXXXXXXXXXXXXXXXX",
        "allocationPct": 5.0,
        "description": "Gridcoin Foundation",
        "registeredTxId": "abc123…",
        "registeredBlockHeight": 3989800,
        "registeredTime": 1717891200,
        "totalPaid": "1234.56789012",
        "payoutCount": 567
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="mss-detail" sx={{ pt: 2, pb: 1 }}>
        Per-recipient detail
      </Typography>
      <Endpoint method="GET" path="/api/mandatory-sidestakes/:address" title="Registry lifecycle + payout history" />
      <Typography gutterBottom variant="body1" component="p">
        Returns the full <code>add → delete → re-add</code> lifecycle
        for the address (every state change on chain) plus the most
        recent 200 payouts. <code>currentStatus</code> is{' '}
        <code>MANDATORY</code> while the recipient is active,{' '}
        <code>DELETED</code> after a removal contract lands. 404 when
        the address has never appeared in the registry.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/mandatory-sidestakes/SFoundationXXXXXXXXXXXXXXXXXXXXXXX'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "mandatory_sidestakes",
    "id": "SFoundationXXXXXXXXXXXXXXXXXXXXXXX",
    "attributes": {
      "address": "SFoundationXXXXXXXXXXXXXXXXXXXXXXX",
      "currentStatus": "MANDATORY",
      "currentAllocationPct": 5.0,
      "currentDescription": "Gridcoin Foundation",
      "totalPaid": "1234.56789012",
      "payoutCount": 567,
      "registry": [
        { "action": "A", "status": "MANDATORY",
          "allocationPct": 5.0, "description": "Gridcoin Foundation",
          "txId": "abc123…", "blockHeight": 3989800,
          "time": 1717891200 }
      ],
      "payouts": [
        { "blockHeight": 3990150, "voutIdx": 2,
          "txId": "def456…", "amount": "0.50000000",
          "time": 1717920000 }
      ]
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="mss-metrics" sx={{ pt: 2, pb: 1 }}>
        Aggregate metrics
      </Typography>
      <Endpoint method="GET" path="/api/metrics/mandatory-sidestakes" title="24h + all-time totals" />
      <Typography gutterBottom variant="body1" component="p">
        Single-round-trip payload for the home-page tile: 24h count,
        amount and distinct recipients, all-time count and amount, and
        the current count of active recipients. Counts only payouts to
        an address that was in the registry in <code>MANDATORY</code>{' '}
        state at that block&apos;s height. While nothing is registered,
        every field reports zero with <code>activeRecipients = 0</code>.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/mandatory-sidestakes'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "mandatory_sidestakes_metrics",
    "id": "now",
    "attributes": {
      "amount24h": "12.34000000",
      "count24h": 567,
      "recipients24h": 3,
      "amountAllTime": "1234.56789012",
      "countAllTime": 12345,
      "activeRecipients": 3
    }
  }
}`}
      />

      <Typography variant="h6" component="h3" id="mss-block" sx={{ pt: 2, pb: 1 }}>
        Per-block payouts
      </Typography>
      <Endpoint method="GET" path="/api/blocks/:height/sidestakes" title="CoinStake extras on a single block" />
      <Typography gutterBottom variant="body1" component="p">
        Lists the CoinStake vout-2+ outputs on this block, joined
        with the registry-at-height so each row carries the
        recipient&apos;s allocation percent and description as-of
        that block. <code>registryStatus = &quot;MANDATORY&quot;</code> means
        the recipient was registered when the block landed;{' '}
        <code>&quot;&quot;</code> (empty) means the output went to a non-protocol
        address — i.e. a local/voluntary sidestake the staker added
        to their own config.
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<code>height</code>}
            secondary="Block height. Returns 400 if non-integer."
          />
        </ListItem>
      </List>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/blocks/3990150/sidestakes'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": [
    {
      "type": "block_sidestake",
      "id": "3990150:2",
      "attributes": {
        "address": "SFoundationXXXXXXXXXXXXXXXXXXXXXXX",
        "voutIdx": 2,
        "txId": "def456…",
        "amount": "0.50000000",
        "time": 1717920000,
        "allocationPct": 5.0,
        "description": "Gridcoin Foundation",
        "registryStatus": "MANDATORY"
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="vss" sx={{ pt: 2, pb: 1 }}>
        Voluntary sidestakes
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Every CoinStake vout-2+ output that is not a mandatory payout
        (above) and not an MRC payout or stake split: sidestakes a
        staker set in their own wallet config. Captured from V13
        blocks on.
      </Typography>
      <Endpoint method="GET" path="/api/metrics/voluntary-sidestakes" title="24h + all-time totals" />
      <Typography gutterBottom variant="body1" component="p">
        Same shape as the mandatory metrics, without{' '}
        <code>activeRecipients</code>.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/metrics/voluntary-sidestakes'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": {
    "type": "voluntary_sidestakes_metrics",
    "id": "now",
    "attributes": {
      "amount24h": "7507.65060402",
      "count24h": 518,
      "recipients24h": 9,
      "amountAllTime": "1124100.24247088",
      "countAllTime": 125274
    }
  }
}`}
      />
      <Endpoint method="GET" path="/api/voluntary-sidestakes" title="Top recipients" />
      <Typography gutterBottom variant="body1" component="p">
        The 100 recipients with the most voluntary sidestakes received
        all-time, largest first, with their 24h slice and the most
        recent payout.
      </Typography>
      <CodeBlock
        caption="Request"
        language="bash"
        code={`curl '${API_BASE}/voluntary-sidestakes'`}
      />
      <CodeBlock
        caption="Response — 200 OK (excerpt)"
        language="json"
        code={`{
  "data": [
    {
      "type": "voluntary_sidestake_recipients",
      "id": "SRecipientXXXXXXXXXXXXXXXXXXXXXXXX",
      "attributes": {
        "address": "SRecipientXXXXXXXXXXXXXXXXXXXXXXXX",
        "totalPaid": "152340.12000000",
        "payoutCount": 4210,
        "amount24h": "762.95000000",
        "count24h": 10,
        "firstBlockHeight": 3990012,
        "lastBlockHeight": 4116770,
        "lastTime": 1792750000
      }
    }
  ]
}`}
      />

      <Typography variant="h6" component="h3" id="mss-sse" sx={{ pt: 2, pb: 1 }}>
        Live updates over SSE
      </Typography>
      <Typography gutterBottom variant="body1" component="p">
        Two topics published on the <code>/events</code> SSE stream:
      </Typography>
      <List dense>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>sidestake.update</code></>}
            secondary="Fires once per registry contract — an address was added, allocation was updated, or an entry was deleted. Payload carries the new state."
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary={<><code>sidestake.payout</code></>}
            secondary="Fires once per V13+ PoS block whose CoinStake had any extras. Payload is a summary: { height, time, count, total } (total in halford). Used to bump the home tile aggregates without rescanning the block range."
          />
        </ListItem>
      </List>
    </Box>
  );
}
