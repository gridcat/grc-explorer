/**
 * Bitcoin Script disassembler — renders the same way an explorer reader
 * expects: opcode mnemonics for non-push ops, raw hex for data pushes.
 *
 * The Gridcoin daemon's getrawtransaction returns an `asm` field that
 * goes through src/script.cpp:CScript::ToString() → ValueString(),
 * which prints direct pushes of ≤4 bytes as decimal integers
 * (`%d` of a CBigNum). For an explorer audience that's misleading —
 * coinbase height pushes, NOPs with a stuffed counter, etc., come out
 * looking like random small numbers. We re-disassemble from the
 * accompanying `hex` and replace the asm in the response.
 *
 * Opcode table mirrors gridcoin's `script.h` (op enum) and
 * `GetOpName()` in `script.cpp`. Modern naming convention: OP_0,
 * OP_1..OP_16 (rather than the "0", "1"..."16" the daemon prints) so
 * pushed data and small-number opcodes are visually distinguishable.
 */

const OP_NAMES: Record<number, string> = {
  // push value
  0x00: 'OP_0',
  0x4c: 'OP_PUSHDATA1',
  0x4d: 'OP_PUSHDATA2',
  0x4e: 'OP_PUSHDATA4',
  0x4f: 'OP_1NEGATE',
  0x50: 'OP_RESERVED',
  0x51: 'OP_1',
  0x52: 'OP_2',
  0x53: 'OP_3',
  0x54: 'OP_4',
  0x55: 'OP_5',
  0x56: 'OP_6',
  0x57: 'OP_7',
  0x58: 'OP_8',
  0x59: 'OP_9',
  0x5a: 'OP_10',
  0x5b: 'OP_11',
  0x5c: 'OP_12',
  0x5d: 'OP_13',
  0x5e: 'OP_14',
  0x5f: 'OP_15',
  0x60: 'OP_16',
  // control
  0x61: 'OP_NOP',
  0x62: 'OP_VER',
  0x63: 'OP_IF',
  0x64: 'OP_NOTIF',
  0x65: 'OP_VERIF',
  0x66: 'OP_VERNOTIF',
  0x67: 'OP_ELSE',
  0x68: 'OP_ENDIF',
  0x69: 'OP_VERIFY',
  0x6a: 'OP_RETURN',
  // stack ops
  0x6b: 'OP_TOALTSTACK',
  0x6c: 'OP_FROMALTSTACK',
  0x6d: 'OP_2DROP',
  0x6e: 'OP_2DUP',
  0x6f: 'OP_3DUP',
  0x70: 'OP_2OVER',
  0x71: 'OP_2ROT',
  0x72: 'OP_2SWAP',
  0x73: 'OP_IFDUP',
  0x74: 'OP_DEPTH',
  0x75: 'OP_DROP',
  0x76: 'OP_DUP',
  0x77: 'OP_NIP',
  0x78: 'OP_OVER',
  0x79: 'OP_PICK',
  0x7a: 'OP_ROLL',
  0x7b: 'OP_ROT',
  0x7c: 'OP_SWAP',
  0x7d: 'OP_TUCK',
  // splice ops
  0x7e: 'OP_CAT',
  0x7f: 'OP_SUBSTR',
  0x80: 'OP_LEFT',
  0x81: 'OP_RIGHT',
  0x82: 'OP_SIZE',
  // bit logic
  0x83: 'OP_INVERT',
  0x84: 'OP_AND',
  0x85: 'OP_OR',
  0x86: 'OP_XOR',
  0x87: 'OP_EQUAL',
  0x88: 'OP_EQUALVERIFY',
  0x89: 'OP_RESERVED1',
  0x8a: 'OP_RESERVED2',
  // numeric
  0x8b: 'OP_1ADD',
  0x8c: 'OP_1SUB',
  0x8d: 'OP_2MUL',
  0x8e: 'OP_2DIV',
  0x8f: 'OP_NEGATE',
  0x90: 'OP_ABS',
  0x91: 'OP_NOT',
  0x92: 'OP_0NOTEQUAL',
  0x93: 'OP_ADD',
  0x94: 'OP_SUB',
  0x95: 'OP_MUL',
  0x96: 'OP_DIV',
  0x97: 'OP_MOD',
  0x98: 'OP_LSHIFT',
  0x99: 'OP_RSHIFT',
  0x9a: 'OP_BOOLAND',
  0x9b: 'OP_BOOLOR',
  0x9c: 'OP_NUMEQUAL',
  0x9d: 'OP_NUMEQUALVERIFY',
  0x9e: 'OP_NUMNOTEQUAL',
  0x9f: 'OP_LESSTHAN',
  0xa0: 'OP_GREATERTHAN',
  0xa1: 'OP_LESSTHANOREQUAL',
  0xa2: 'OP_GREATERTHANOREQUAL',
  0xa3: 'OP_MIN',
  0xa4: 'OP_MAX',
  0xa5: 'OP_WITHIN',
  // crypto
  0xa6: 'OP_RIPEMD160',
  0xa7: 'OP_SHA1',
  0xa8: 'OP_SHA256',
  0xa9: 'OP_HASH160',
  0xaa: 'OP_HASH256',
  0xab: 'OP_CODESEPARATOR',
  0xac: 'OP_CHECKSIG',
  0xad: 'OP_CHECKSIGVERIFY',
  0xae: 'OP_CHECKMULTISIG',
  0xaf: 'OP_CHECKMULTISIGVERIFY',
  // expansion
  0xb0: 'OP_NOP1',
  0xb1: 'OP_CHECKLOCKTIMEVERIFY',
  0xb2: 'OP_CHECKSEQUENCEVERIFY',
  0xb3: 'OP_NOP4',
  0xb4: 'OP_NOP5',
  0xb5: 'OP_NOP6',
  0xb6: 'OP_NOP7',
  0xb7: 'OP_NOP8',
  0xb8: 'OP_NOP9',
  0xb9: 'OP_NOP10',
  // template matching params (not real script ops)
  0xf9: 'OP_SMALLDATA',
  0xfa: 'OP_SMALLINTEGER',
  0xfb: 'OP_PUBKEYS',
  0xfd: 'OP_PUBKEYHASH',
  0xfe: 'OP_PUBKEY',
  0xff: 'OP_INVALIDOPCODE',
};

/**
 * Disassemble a script hex string into space-separated tokens.
 * Direct pushes (0x01..0x4b) and OP_PUSHDATA1/2/4 emit the pushed
 * bytes as hex (always — no decimal conversion). Everything else is
 * the opcode mnemonic.
 *
 * Returns the original hex with `[error]` suffix if the script
 * truncates mid-push (matches gridcoind's behavior, never throws).
 */
export function disassembleScript(hex: string): string {
  if (!hex) return '';
  const bytes = Buffer.from(hex, 'hex');
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    i += 1;

    // Direct push of N bytes (0x01 .. 0x4b)
    if (op >= 0x01 && op <= 0x4b) {
      if (i + op > bytes.length) { out.push('[error]'); break; }
      out.push(bytes.subarray(i, i + op).toString('hex'));
      i += op;
      continue;
    }

    // Length-prefixed pushes
    if (op === 0x4c) { // OP_PUSHDATA1
      if (i + 1 > bytes.length) { out.push('[error]'); break; }
      const len = bytes[i];
      i += 1;
      if (i + len > bytes.length) { out.push('[error]'); break; }
      out.push(bytes.subarray(i, i + len).toString('hex'));
      i += len;
      continue;
    }
    if (op === 0x4d) { // OP_PUSHDATA2
      if (i + 2 > bytes.length) { out.push('[error]'); break; }
      const len = bytes.readUInt16LE(i);
      i += 2;
      if (i + len > bytes.length) { out.push('[error]'); break; }
      out.push(bytes.subarray(i, i + len).toString('hex'));
      i += len;
      continue;
    }
    if (op === 0x4e) { // OP_PUSHDATA4
      if (i + 4 > bytes.length) { out.push('[error]'); break; }
      const len = bytes.readUInt32LE(i);
      i += 4;
      if (i + len > bytes.length) { out.push('[error]'); break; }
      out.push(bytes.subarray(i, i + len).toString('hex'));
      i += len;
      continue;
    }

    // Named opcode or fallback to numeric.
    out.push(OP_NAMES[op] ?? `OP_UNKNOWN(0x${op.toString(16).padStart(2, '0')})`);
  }
  return out.join(' ');
}
