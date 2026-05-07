import type { GetServerSidePropsContext } from 'next';

/**
 * XML helpers shared by every sitemap endpoint. The wire format is
 * sitemaps.org 0.9 — every search engine accepts it, no additional
 * features (image sitemaps, video sitemaps, etc.) are needed for an
 * explorer.
 *
 * Per the design: three-tier sitemap structure
 *   /sitemap.xml         → index that points at the three children
 *   /sitemaps/static     → top-level pages
 *   /sitemaps/archive    → date hierarchy (years × months × days)
 *   /sitemaps/blocks-N   → per-block canonical (50k URLs per chunk)
 *
 * Search engines fetch the index, then each child. Chunking the per-
 * block sitemap keeps every file under the 50,000-URL / 50MB limit
 * Google enforces.
 */

export const URLS_PER_BLOCKS_CHUNK = 50_000;

/** Build the canonical origin from the incoming request. nginx forwards
 *  X-Forwarded-Host / X-Forwarded-Proto in the production deployment;
 *  the Host header is the dev fallback. */
export function originOf(ctx: GetServerSidePropsContext): string {
  const proto = (ctx.req.headers['x-forwarded-proto'] as string)
    || (ctx.req.socket && (ctx.req.socket as unknown as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = (ctx.req.headers['x-forwarded-host'] as string)
    ?? (ctx.req.headers.host as string)
    ?? 'localhost:3002';
  return `${proto}://${host}`;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod?: string;
}

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

export function urlsetXml(entries: SitemapEntry[]): string {
  const parts = [HEADER, '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'];
  for (const e of entries) {
    parts.push('  <url>\n');
    parts.push(`    <loc>${escapeXml(e.loc)}</loc>\n`);
    if (e.lastmod) parts.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>\n`);
    if (e.changefreq) parts.push(`    <changefreq>${e.changefreq}</changefreq>\n`);
    if (e.priority !== undefined) parts.push(`    <priority>${e.priority.toFixed(1)}</priority>\n`);
    parts.push('  </url>\n');
  }
  parts.push('</urlset>\n');
  return parts.join('');
}

export function sitemapIndexXml(entries: SitemapIndexEntry[]): string {
  const parts = [HEADER, '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'];
  for (const e of entries) {
    parts.push('  <sitemap>\n');
    parts.push(`    <loc>${escapeXml(e.loc)}</loc>\n`);
    if (e.lastmod) parts.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>\n`);
    parts.push('  </sitemap>\n');
  }
  parts.push('</sitemapindex>\n');
  return parts.join('');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Set headers + write XML response. Caller returns `{ props: {} }`
 *  after invoking — Next sees props returned and ends the request. */
export function writeXml(ctx: GetServerSidePropsContext, xml: string, maxAgeSeconds = 3600): void {
  ctx.res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  ctx.res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`);
  ctx.res.write(xml);
  ctx.res.end();
}

/** Same shape as writeXml but for plain-text responses (robots.txt, llms.txt). */
export function writeText(ctx: GetServerSidePropsContext, text: string, maxAgeSeconds = 3600): void {
  ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  ctx.res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`);
  ctx.res.write(text);
  ctx.res.end();
}
