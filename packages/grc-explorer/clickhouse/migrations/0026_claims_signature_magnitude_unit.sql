-- Claim audit fields the PoS-block claim payload carries that we
-- previously dropped:
--
--   * `signature` — ECDSA signature over the claim payload, generated
--     by the staker with their beacon's private key. Combined with
--     the beacon's public key and the claim message bytes, it lets
--     anyone verify "this PoS block legitimately carries CPID X's
--     claim and not someone else's." No codec: ECDSA bytes are
--     high-entropy, ZSTD burns CPU for ~0 gain.
--
--   * `magnitude_unit` — per-claim conversion rate from magnitude
--     to GRC reward. V13's "Magnitude unit exceeds 1/4" change makes
--     this a per-block parameter; capturing it alongside `magnitude`
--     and `research_subsidy` lets future analyses compute exact
--     rewards without re-deriving the consensus formula.
ALTER TABLE claims
ADD COLUMN IF NOT EXISTS signature String DEFAULT '';

ALTER TABLE claims
ADD COLUMN IF NOT EXISTS magnitude_unit Float64 DEFAULT 0;
