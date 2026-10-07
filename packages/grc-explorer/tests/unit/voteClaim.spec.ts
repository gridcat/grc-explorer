import { describe, expect, it } from 'vitest';
import {
  packVoteMessage, RpcVoteClaim, verifiedClaimAddresses, verifyAddressClaim,
} from '../../src/lib/voteClaim';

// Real mainnet vote bdacb5cb…687e (block 4,068,938): one address claim
// for SDK78s3v… over two outpoints, response [0] on poll 34e1eb0b…,
// spending 50cd24a4…:1. Claim as returned by `getvotingclaim`.
const POLL = '34e1eb0b356cf00686c5c4d8dad33a30b2f12cb3473b804adc048ea2d0901031';
const VIN = { txid: '50cd24a4c1ed8f07ace0a26d06ef93d0c800276ee85c92a32fc35720b4444526', n: 1 };
const N_TIME = 1788033010;
const CLAIM: RpcVoteClaim = {
  version: 1,
  balanceClaim: [{
    publicKey: '0304b197503da00679139347d81cc2f99e13dedde6c40527e061070f75de1fb8b4',
    signature: '304402204a616e76c4727bc03f1e2829ff819f57713209600d3b0727c809acb3be6b173d022074a341ef598ed1cfa6c43a65eb89ae6fdd45e420a6bc972e31a02cab1de2aa0f',
    outpoints: [
      { txid: '50cd24a4c1ed8f07ace0a26d06ef93d0c800276ee85c92a32fc35720b4444526', offset: 1 },
      { txid: 'ab7e7e2174b735229f796192ae77d33554ab254ce6c78c3d0710ebbbfabdebea', offset: 1 },
    ],
  }],
};
const VOTE = {
  pollTxid: POLL, choices: [0], nTime: N_TIME, prevouts: [VIN],
};

describe('vote claim verification', () => {
  it('verifies the real claim and derives its address', () => {
    expect(verifiedClaimAddresses(CLAIM, VOTE, 'mainnet')).toEqual(['SDK78s3vM4DCNarx2qWVoGMCpsSXR3SgNU']);
  });

  it('rejects the claim when any signed field differs', () => {
    const claim = CLAIM.balanceClaim![0];
    const msg = (over: Partial<Parameters<typeof packVoteMessage>[0]>) => packVoteMessage({
      pollTxid: POLL, responses: [0], nTime: N_TIME, prevouts: [VIN], ...over,
    });
    expect(verifyAddressClaim(claim, msg({}))).toBe(true);
    expect(verifyAddressClaim(claim, msg({ nTime: N_TIME + 1 }))).toBe(false);
    expect(verifyAddressClaim(claim, msg({ responses: [1] }))).toBe(false);
    expect(verifyAddressClaim(claim, msg({ prevouts: [{ ...VIN, n: 0 }] }))).toBe(false);
  });

  it('rejects a forged claim: a valid signature moved onto another key', () => {
    const forged: RpcVoteClaim = {
      balanceClaim: [{
        ...CLAIM.balanceClaim![0],
        publicKey: '02f430d0005f9d1eed3f091344111d2f89443debc2e9d49dd17b6ad3a5f63551bc',
      }],
    };
    expect(verifiedClaimAddresses(forged, VOTE, 'mainnet')).toEqual([]);
  });

  it('drops invalid claims but keeps the valid ones of the same vote', () => {
    const mixed: RpcVoteClaim = {
      balanceClaim: [
        CLAIM.balanceClaim![0],
        { ...CLAIM.balanceClaim![0], publicKey: '02f430d0005f9d1eed3f091344111d2f89443debc2e9d49dd17b6ad3a5f63551bc' },
      ],
    };
    expect(verifiedClaimAddresses(mixed, VOTE, 'mainnet')).toEqual(['SDK78s3vM4DCNarx2qWVoGMCpsSXR3SgNU']);
  });

  it('survives malformed claim fields', () => {
    const bad: RpcVoteClaim = {
      balanceClaim: [
        { publicKey: 'zz', signature: '00', outpoints: [] },
        { publicKey: CLAIM.balanceClaim![0].publicKey, signature: 'not-hex', outpoints: CLAIM.balanceClaim![0].outpoints },
      ],
    };
    expect(verifiedClaimAddresses(bad, VOTE, 'mainnet')).toEqual([]);
    expect(verifiedClaimAddresses({}, VOTE, 'mainnet')).toEqual([]);
  });
});
