<p align="center">
  <a href="https://explorer.gridcoin.club">
    <img src="packages/grc-explorer-frontend/public/ic-logo-mainnet.svg" alt="Gridcoin Block Explorer logo" width="96" height="96">
  </a>
</p>

<h1 align="center">Gridcoin Block Explorer</h1>

<p align="center"><strong>Live at <a href="https://explorer.gridcoin.club">explorer.gridcoin.club</a></strong></p>

An open-source block explorer for [Gridcoin](https://gridcoin.us) (GRC). Gridcoin pays people for running science projects on their computers through BOINC, so its chain carries things most coins don't have: researcher beacons, superblocks, magnitudes, polls and mandatory sidestakes. The explorer shows those alongside the usual blocks, transactions and addresses.

## What's in there

If you just want to see what the chain is doing, start with the [blocks](https://explorer.gridcoin.club/blocks) list, the [mempool](https://explorer.gridcoin.club/mempool) or the [rich list](https://explorer.gridcoin.club/wallets). Any block, transaction or address opens its own page from there.

On the research side you can browse every [beacon](https://explorer.gridcoin.club/beacons) and every [superblock](https://explorer.gridcoin.club/superblocks) along with the magnitudes it recorded. Manual reward claims and the whitelisted BOINC projects have their own pages too.

[Polls](https://explorer.gridcoin.club/polls) show each on-chain vote and how it ended. The mandatory sidestakes page lists the addresses the protocol sends a share of every staking reward to, and how much each has received so far.

The [chain history](https://explorer.gridcoin.club/history) goes year by year back to genesis. Next to it, the [consensus forks](https://explorer.gridcoin.club/protocol) page shows when each protocol upgrade activated, and the charts follow difficulty, stakers and researchers over the life of the chain.

## For developers

Everything on the site is also available through a free public API. You don't need a key or an account. The docs are at [explorer.gridcoin.club/developers](https://explorer.gridcoin.club/developers).

## FAQ

**Is it free?** Yes. The site and the API are free and need no account.

**Which network does it cover?** Gridcoin mainnet, every block from genesis to the current tip.

**How do I check a Gridcoin transaction or address?** Paste the transaction ID, address or block number into [search](https://explorer.gridcoin.club/search). You'll see the amount, confirmations, inputs and outputs, or for an address, its balance and full history.

**Can I look up my BOINC researcher (CPID)?** Yes. Paste the CPID into [search](https://explorer.gridcoin.club/search) to see its beacon, magnitude history and linked wallets.

**What is a superblock?** A block the network produces about once a day that records the magnitude of every active researcher. Research rewards are calculated from it. [Browse superblocks](https://explorer.gridcoin.club/superblocks).

**What is a beacon?** The on-chain link between a BOINC account (identified by its CPID) and a Gridcoin wallet. A researcher needs an active beacon to earn research rewards. [Browse beacons](https://explorer.gridcoin.club/beacons).

**What is magnitude?** How much BOINC work a researcher does across the projects Gridcoin rewards, expressed as a number. The higher it is, the bigger their share of research rewards.

**Does it track my visit?** Only through [Plausible](https://plausible.io) analytics, which doesn't set cookies or collect personal data.

## Part of Gridcoin Club

[Gridcoin Club](https://gridcoin.club) is a small family of free tools for the Gridcoin community, and the explorer is one of them.

## License

[MIT](LICENSE)

---

<p align="center">Made with ❤️ by <a href="https://github.com/gridcat">@gridcat</a></p>
