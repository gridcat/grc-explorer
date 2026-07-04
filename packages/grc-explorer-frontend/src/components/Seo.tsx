import Head from 'next/head';
import { IS_TESTNET, LOGO_PATH } from '@/lib/network';

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://explorer.gridcoin.club';
// Bare hostname (no scheme) — for prose like `<code>explorer.gridcoin.club</code>`
// references that should track whichever build the user is on.
export const SITE_HOST = SITE_URL.replace(/^https?:\/\//, '');
export const SITE_NAME = 'Gridcoin Block Explorer';

interface SeoProps {
  title: string;
  description: string;
  path: string;
  ogType?: 'website' | 'article';
  jsonLd?: Record<string, unknown>;
  noindex?: boolean;
  iconDataUrl?: string;
  ogImagePath?: string;
}

/**
 * Family-standard SEO head — identical contract to the stamp / grcpay /
 * grcfeed / apex `Seo` components. Emits title, meta description, canonical,
 * OpenGraph + Twitter cards, favicon and optional JSON-LD. Every page passes
 * a specific `title` + `description` + canonical `path`; dynamic pages derive
 * them from their fetched entity so each URL gets a unique, descriptive head.
 */
export function Seo({
  title,
  description,
  path,
  ogType = 'website',
  jsonLd,
  noindex,
  iconDataUrl,
  ogImagePath,
}: SeoProps) {
  const canonicalUrl = `${SITE_URL}${path}`;
  // The explorer ships no dedicated OG raster; fall back to the per-network
  // logo so shares still carry brand art. Callers with a better image pass
  // `ogImagePath`.
  const ogImageUrl = `${SITE_URL}${ogImagePath ?? LOGO_PATH}`;

  // Family-wide convention: every testnet build prepends `[testnet] ` to the
  // page title so the network is obvious in tab/favicon views.
  const displayTitle = IS_TESTNET ? `[testnet] ${title}` : title;

  return (
    <Head>
      <title>{displayTitle}</title>
      <meta key="description" name="description" content={description} />
      <link key="canonical" rel="canonical" href={canonicalUrl} />

      {/*
        Always emit a favicon link — next/head only replaces tags by key, so
        a page that omits it entirely would leave the previous page's icon
        stuck in the tab until a full reload. Modern browsers prefer the SVG
        when both are present; the .ico is the fallback for older clients
        and the per-page `iconDataUrl` override.
      */}
      <link
        key="icon-svg"
        rel="icon"
        type="image/svg+xml"
        href={LOGO_PATH}
      />
      <link
        key="icon"
        rel="icon"
        type="image/x-icon"
        href={iconDataUrl ?? '/favicon.ico'}
      />

      <meta key="og:title" property="og:title" content={displayTitle} />
      <meta key="og:description" property="og:description" content={description} />
      <meta key="og:type" property="og:type" content={ogType} />
      <meta key="og:url" property="og:url" content={canonicalUrl} />
      <meta key="og:image" property="og:image" content={ogImageUrl} />
      <meta key="og:site_name" property="og:site_name" content={SITE_NAME} />
      <meta key="og:locale" property="og:locale" content="en_US" />

      <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
      <meta key="twitter:title" name="twitter:title" content={displayTitle} />
      <meta key="twitter:description" name="twitter:description" content={description} />
      <meta key="twitter:image" name="twitter:image" content={ogImageUrl} />

      {noindex && <meta key="robots" name="robots" content="noindex, nofollow" />}
      {jsonLd && (
        <script
          key="jsonld"
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/<\//g, '<\\/') }}
        />
      )}
    </Head>
  );
}
