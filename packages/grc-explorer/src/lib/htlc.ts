// Proper HTLC-redemption detection.
//
// The previous detector byte-scanned the whole scriptSig for 0xb1 /
// 0xb2 and called any hit an HTLC. But a scriptSig is mostly PUSHED
// DATA (DER signatures, pubkeys) — those bytes are not opcodes. A
// ~105-byte P2PKH/coinstake scriptSig has a ~56% chance of containing
// a stray 0xb1/0xb2 inside the signature, so it false-flagged a huge
// fraction of ordinary inputs (verified on a real coinstake tx whose
// 0xb2 was inside the ECDSA `s` value).
//
// Correct approach: a P2SH redemption's scriptSig ends with a push of
// the redeemScript. Parse the scriptSig into tokens, take the final
// push as the redeemScript, parse THAT into opcodes, and only treat
// it as an HTLC if its *opcodes* form a hashlock + timelock + branch
// shape. Because we inspect parsed opcodes (never bytes inside a data
// push), signature/pubkey coincidences cannot match.
//
// This is intentionally fork-agnostic — the V14 activation gate is
// applied by the caller (routes/transactions.ts) so this stays a pure
// script helper with no consensus-table dependency.

type Token = { op: number } | { data: Buffer };

// Minimal Bitcoin-script tokenizer. Returns null on a malformed /
// truncated script (a real redeemScript always parses cleanly).
function tokenize(buf: Buffer): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < buf.length) {
    const op = buf[i];
    i += 1;
    if (op >= 0x01 && op <= 0x4b) {
      if (i + op > buf.length) return null;
      out.push({ data: buf.subarray(i, i + op) });
      i += op;
    } else if (op === 0x4c) {
      if (i + 1 > buf.length) return null;
      const n = buf[i]; i += 1;
      if (i + n > buf.length) return null;
      out.push({ data: buf.subarray(i, i + n) }); i += n;
    } else if (op === 0x4d) {
      if (i + 2 > buf.length) return null;
      const n = buf.readUInt16LE(i); i += 2;
      if (i + n > buf.length) return null;
      out.push({ data: buf.subarray(i, i + n) }); i += n;
    } else if (op === 0x4e) {
      if (i + 4 > buf.length) return null;
      const n = buf.readUInt32LE(i); i += 4;
      if (i + n > buf.length) return null;
      out.push({ data: buf.subarray(i, i + n) }); i += n;
    } else {
      out.push({ op });
    }
  }
  return out;
}

const OP_IF = 0x63;
const OP_NOTIF = 0x64;
const OP_ENDIF = 0x68;
const OP_EQUAL = 0x87;
const OP_EQUALVERIFY = 0x88;
const OP_HASH160 = 0xa9;
const OP_SHA256 = 0xa8;
const OP_HASH256 = 0xaa;
const OP_CHECKLOCKTIMEVERIFY = 0xb1;
const OP_CHECKSEQUENCEVERIFY = 0xb2;

/**
 * True iff this input spends a P2SH HTLC: its scriptSig's final push
 * (the redeemScript) parses to opcodes that contain both a timelock
 * (OP_CHECKLOCKTIMEVERIFY / OP_CHECKSEQUENCEVERIFY) and a hashlock
 * (OP_SHA256/OP_HASH160/OP_HASH256 + OP_EQUAL[VERIFY]) inside an
 * IF/ENDIF branch — the canonical hash-timelock-contract shape.
 *
 * A bare CLTV timelock (no hashlock) or a stray opcode byte inside a
 * signature both correctly return false.
 */
export function redeemScriptIsHtlc(scriptSigHex: string | null | undefined): boolean {
  if (!scriptSigHex) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(scriptSigHex, 'hex');
  } catch {
    return false;
  }
  if (sig.length === 0) return false;

  const sigTokens = tokenize(sig);
  if (!sigTokens || sigTokens.length === 0) return false;
  // P2SH redemption: the last item is the serialized redeemScript.
  const last = sigTokens[sigTokens.length - 1];
  if (!('data' in last) || last.data.length === 0) return false;

  const redeem = tokenize(last.data);
  if (!redeem) return false;

  const ops = new Set<number>();
  for (const t of redeem) {
    if ('op' in t) ops.add(t.op);
  }

  const hasTimelock = ops.has(OP_CHECKLOCKTIMEVERIFY) || ops.has(OP_CHECKSEQUENCEVERIFY);
  const hasHashlock = (ops.has(OP_HASH160) || ops.has(OP_SHA256) || ops.has(OP_HASH256))
    && (ops.has(OP_EQUAL) || ops.has(OP_EQUALVERIFY));
  const hasBranch = (ops.has(OP_IF) || ops.has(OP_NOTIF)) && ops.has(OP_ENDIF);

  return hasTimelock && hasHashlock && hasBranch;
}
