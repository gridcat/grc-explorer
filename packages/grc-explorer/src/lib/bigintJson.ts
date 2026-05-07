// Teach JSON.stringify how to serialize BigInt. Without this, any
// route that passes a Prisma row containing a BigInt column straight
// to res.send() (instead of going through a presenter that calls
// halford2grc) crashes with "Do not know how to serialize a BigInt".
//
// Imported once at the top of src/index.ts and src/api.ts so it's
// active for both the indexer process and any api-only replica.
//
// Why string instead of number: Gridcoin amounts in halford routinely
// exceed Number.MAX_SAFE_INTEGER (2^53). Stringifying preserves the
// exact value; consumers can re-parse with BigInt(x) if they need
// arithmetic.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  interface BigInt {
    toJSON(): string;
  }
}

if (!('toJSON' in BigInt.prototype)) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value(this: bigint): string {
      return this.toString();
    },
    configurable: true,
    writable: true,
  });
}

export {};
