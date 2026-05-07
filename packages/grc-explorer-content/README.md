# grc-explorer-content

Editorial content for the Gridcoin block explorer — markdown articles
that turn date-archive pages into a readable history of the chain.

```
blocks/
  years/         year reviews    (YYYY.md)        long-form, ~500-1000 words
  months/        month notes     (YYYY-MM.md)     stat-only template, optional 1 sentence
  forks/         fork landmarks  (slug.md)        canonical "what is the X fork" page
projects/        BOINC project profiles           one per whitelisted project
```

## Article frontmatter

Every article uses this shape (year example):

```markdown
---
year: 2018
hero_event: "Fern hard fork"
summary: "The year Gridcoin moved from BOINC-verification-by-trust to..."
releases:
  - { version: "4.0.0.0", date: "2018-08-25", url: "https://github.com/gridcoin-community/Gridcoin-Research/releases/tag/4.0.0.0" }
landmarks:
  - { block: 1420001, label: "Fern activation" }
sources:
  - { title: "Gridcoin 4.0.0.0 release notes", url: "https://github.com/...", dofollow: true }
---

## Body in markdown

Use {{stat:total_blocks}} placeholders to inline live numbers from CH —
the renderer replaces them at SSR time.
```

## Linking conventions

Per the gridcoin.club outbound-link policy:

* `gridcoin-community/*`, `gridcat/*`, `gridcoin.us`, `*.gridcoin.club`
  → dofollow (set `dofollow: true` in `sources`)
* Everything else → nofollow (default)

## Stamping

When an article is published, the build pipeline timestamps the rendered
markdown via stamp.gridcoin.club. The resulting tx-id goes into the
article's `stamp_tx` frontmatter field, footer renders a "verified
on-chain" line linking to the proof.
