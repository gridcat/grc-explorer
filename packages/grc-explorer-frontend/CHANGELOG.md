# [grc-explorer-frontend-v2.4.1](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.4.0...grc-explorer-frontend-v2.4.1) (2026-10-03)


### Bug Fixes

* refresh rollups for the new block only and stop the stale network tip ([a531274](https://github.com/gridcat/grc-explorer/commit/a531274d39661a9087c94d48d0c3812938fafcdf))

# [grc-explorer-frontend-v2.4.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.3.0...grc-explorer-frontend-v2.4.0) (2026-10-03)


### Features

* bound address page linked-wallets lookup and log slow requests ([cdb06a0](https://github.com/gridcat/grc-explorer/commit/cdb06a0c59bf8d18308a2ea0105613d0493c9bf6))

# [grc-explorer-frontend-v2.3.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.2.1...grc-explorer-frontend-v2.3.0) (2026-10-03)


### Features

* add ?sort=height to address and CPID staked-blocks endpoints ([49c69c7](https://github.com/gridcat/grc-explorer/commit/49c69c7c8acc5bca6894c853cfae6cad13ab71c2))

# [grc-explorer-frontend-v2.2.1](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.2.0...grc-explorer-frontend-v2.2.1) (2026-10-03)


### Bug Fixes

* drop testnet references from explorer docs ([591bdcd](https://github.com/gridcat/grc-explorer/commit/591bdcd10e121aff67c2c7a76d4344ad7ae301ac))

# [grc-explorer-frontend-v2.2.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.1.2...grc-explorer-frontend-v2.2.0) (2026-10-03)


### Bug Fixes

* correct and update the history articles for 2013-2026 ([e25ef28](https://github.com/gridcat/grc-explorer/commit/e25ef28ef800d6417bbe796e1bd268b7c5be88a7))
* retire cohorts ([a3a6f57](https://github.com/gridcat/grc-explorer/commit/a3a6f577ed66e9ba101b354fc6c132a239035315))


### Features

* add address blocks endpoint ([8cd7f6a](https://github.com/gridcat/grc-explorer/commit/8cd7f6abbcb0ac64ec3af126922de085a9637453))

# [grc-explorer-frontend-v2.1.2](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.1.1...grc-explorer-frontend-v2.1.2) (2026-10-03)


### Bug Fixes

* bump next and sharp, drop unused yayson ([e56be77](https://github.com/gridcat/grc-explorer/commit/e56be775c89976f248139c1e20ecaa9ef6c1348d))
* bump vulnerable production dependencies ([8c543f0](https://github.com/gridcat/grc-explorer/commit/8c543f0f97940bb64af9264446a68da1fcf2436f))
* cap concurrent SSR sockets to the API ([350a5cd](https://github.com/gridcat/grc-explorer/commit/350a5cdfdf77d9602c28dfc4036928ad5f75d7f4))
* edge-cache SSR pages and forward visitor IP/UA to the API ([a0f6186](https://github.com/gridcat/grc-explorer/commit/a0f6186371e1b4789166659b06859fbe60c07272))
* load the address balance sparkline only when scrolled into view ([d4ccaaf](https://github.com/gridcat/grc-explorer/commit/d4ccaaf966578cebac9c486b7b0ba4bfa70a8a5d))

# [grc-explorer-frontend-v2.1.1](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.1.0...grc-explorer-frontend-v2.1.1) (2026-08-30)


### Bug Fixes

* add rate limits for ai to robots.txt ([779c5e1](https://github.com/gridcat/grc-explorer/commit/779c5e11b542a896ee8926987c1bc3cacdbdc233))

# [grc-explorer-frontend-v2.1.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.0.2...grc-explorer-frontend-v2.1.0) (2026-08-28)


### Features

* update logos ([d56ab8d](https://github.com/gridcat/grc-explorer/commit/d56ab8d51a8517fef99a3c7b4c5788cbf8e93dc9))

# [grc-explorer-frontend-v2.0.2](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.0.1...grc-explorer-frontend-v2.0.2) (2026-08-20)


### Bug Fixes

* linter issues ([876672c](https://github.com/gridcat/grc-explorer/commit/876672c4bf1fff058185e56e41114ba6bd54da5e))
* performance improvements ([f999dbf](https://github.com/gridcat/grc-explorer/commit/f999dbf9e0bba0904a34d1dcaf7bd7d9cff1c150))

# [grc-explorer-frontend-v2.0.1](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v2.0.0...grc-explorer-frontend-v2.0.1) (2026-07-05)


### Bug Fixes

* trim superblock SSR + estimate rich-list total ([60c432f](https://github.com/gridcat/grc-explorer/commit/60c432faafc54a37e0417cc431e49d9f806cc600))

# [grc-explorer-frontend-v2.0.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.5.0...grc-explorer-frontend-v2.0.0) (2026-07-04)


### Features

* migrate datastore to MariaDB and run the explorer on a 2 GB box ([9756bbf](https://github.com/gridcat/grc-explorer/commit/9756bbffa5f32369767d04b9c216e1444d95284f))


### BREAKING CHANGES

* datastore is now MariaDB; production must be re-seeded from a mariabackup physical backup rather than upgraded in place.

# [grc-explorer-frontend-v1.5.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.4.0...grc-explorer-frontend-v1.5.0) (2026-06-27)


### Features

* change email, cpid block list ([670967a](https://github.com/gridcat/grc-explorer/commit/670967af366da144b3c14c9aae2818f0b90fe7e4))

# [grc-explorer-frontend-v1.4.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.3.0...grc-explorer-frontend-v1.4.0) (2026-06-16)


### Bug Fixes

* update deps ([97c0bed](https://github.com/gridcat/grc-explorer/commit/97c0bed9cb894e3dddab61fcc59f73ba89807424))


### Features

* migrate to duckdb ([a0e32b3](https://github.com/gridcat/grc-explorer/commit/a0e32b3f62a94e98882675da7f7be7d93876573f))

# [grc-explorer-frontend-v1.3.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.2.1...grc-explorer-frontend-v1.3.0) (2026-05-17)


### Features

* improve blocks page, add usernames ([c29ae24](https://github.com/gridcat/grc-explorer/commit/c29ae24de4c5fce436bb58f133bae74650a4af42))

# [grc-explorer-frontend-v1.2.1](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.2.0...grc-explorer-frontend-v1.2.1) (2026-05-17)


### Bug Fixes

* update homepage to be lighter ([dbca306](https://github.com/gridcat/grc-explorer/commit/dbca306b97d124d452473f28b36a865af0dd3cde))

# [grc-explorer-frontend-v1.2.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.1.1...grc-explorer-frontend-v1.2.0) (2026-05-16)


### Features

* som many fixes and features, so I literally lost track of it ([ad44b6d](https://github.com/gridcat/grc-explorer/commit/ad44b6d38ddea262b9ba3387d6841e95060e5453))

# [grc-explorer-frontend-v1.1.1](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.1.0...grc-explorer-frontend-v1.1.1) (2026-05-12)


### Bug Fixes

* a lot of fixes and other improvements ([307b8d8](https://github.com/gridcat/grc-explorer/commit/307b8d82d0b733c0ebdad87a02f352a3df2bd9a3))
* kilo must be capital ([084758a](https://github.com/gridcat/grc-explorer/commit/084758ac37cf16c4c45c09054e26703e11932143))

# [grc-explorer-frontend-v1.1.0](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.0.3...grc-explorer-frontend-v1.1.0) (2026-05-11)


### Features

* **explorer:** protocol audit + /protocol pages + fork-aware UI ([e820a65](https://github.com/gridcat/grc-explorer/commit/e820a6588a3988bf1946690594fecf59898e5e90))

# [grc-explorer-frontend-v1.0.3](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.0.2...grc-explorer-frontend-v1.0.3) (2026-05-09)


### Bug Fixes

* resolve tracking env variable server side ([d91fad4](https://github.com/gridcat/grc-explorer/commit/d91fad4a04c9133051333b8f7ee5c4a44508e942))

# [grc-explorer-frontend-v1.0.2](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.0.1...grc-explorer-frontend-v1.0.2) (2026-05-08)


### Bug Fixes

* fix hosts ([683db98](https://github.com/gridcat/grc-explorer/commit/683db982ab8d038513b7a9d3f4069404d25abf4b))

# [grc-explorer-frontend-v1.0.1](https://github.com/gridcat/grc-explorer/compare/grc-explorer-frontend-v1.0.0...grc-explorer-frontend-v1.0.1) (2026-05-08)


### Bug Fixes

* mainnet is default ([427137c](https://github.com/gridcat/grc-explorer/commit/427137c4588de45349fa44f0b815c2c1727b789f))

# grc-explorer-frontend-v1.0.0 (2026-05-08)


### Bug Fixes

* fix lock file ([32ea711](https://github.com/gridcat/grc-explorer/commit/32ea7110886508a656deebb180df7e88327b7312))
* fix style issues ([3cad5c5](https://github.com/gridcat/grc-explorer/commit/3cad5c524b86d1c05c53bde1493dc624661184ef))
* init locks ([4d87deb](https://github.com/gridcat/grc-explorer/commit/4d87debc0f975b42aeb43aea6faf4b7169fb61ad))
* regenerate lock files ([6b4e689](https://github.com/gridcat/grc-explorer/commit/6b4e689fa53b3cccb8f31dd2422fddf46b40f82d))
* regenerate lock files again ([bf070ce](https://github.com/gridcat/grc-explorer/commit/bf070cec4235ec3c19252235da2be4aa35568f57))


### Features

* a lot of UI bugfixes, mempool, mrc ([c5e0ce8](https://github.com/gridcat/grc-explorer/commit/c5e0ce85a57bca691f040f36efa9418e2272d9fd))
* initial commit ([46f5c39](https://github.com/gridcat/grc-explorer/commit/46f5c3946a5ff93fc182001200e504600b6c4941))
