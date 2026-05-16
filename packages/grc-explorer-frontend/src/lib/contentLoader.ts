import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, type Frontmatter } from './frontmatter';

/**
 * Server-side article loader. Resolves a markdown file from the
 * sibling content package and returns its parsed frontmatter + body.
 * Returns null when the article doesn't exist — callers (year/month/
 * day SSR pages) treat the absence as "no editorial content yet" and
 * still render the bare data overview.
 *
 * Path resolution prefers the env var `EXPLORER_CONTENT_DIR` (set in
 * docker-compose to point at the bind-mounted content package) and
 * falls back to a relative path that works in dev when running from
 * the frontend package directory.
 */

// Resolved once per process — both branches of the fallback are
// deterministic at boot time. Dev fallback is `../grc-explorer-content`
// from process.cwd(), which is the frontend package dir under both
// `npm run dev` and the Docker bind-mount layout.
const CONTENT_DIR = process.env.EXPLORER_CONTENT_DIR
  ?? path.resolve(process.cwd(), '..', 'grc-explorer-content');

// SSR cache: articles change at most a few times a year and the
// loader is in the hot path of every year/month/day page request.
// `null` is cached too, so a missing article doesn't fs-stat every
// time. TTL of 5 minutes balances editorial responsiveness against
// per-request fs cost; dev restart-on-edit re-builds the module
// anyway, so authoring feedback isn't gated by this.
const ARTICLE_TTL_MS = 5 * 60 * 1000;
const articleCache = new Map<string, { value: Frontmatter | null; expiresAt: number }>();
async function loadArticleCached(filePath: string): Promise<Frontmatter | null> {
  const now = Date.now();
  const cached = articleCache.get(filePath);
  if (cached && cached.expiresAt > now) return cached.value;
  const raw = await readIfExists(filePath);
  const value = raw ? parseFrontmatter(raw) : null;
  articleCache.set(filePath, { value, expiresAt: now + ARTICLE_TTL_MS });
  return value;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT is a normal "no article for this period" — silent.
    // Anything else (EACCES, EISDIR, mount-not-present, etc.) means
    // the loader is mis-configured; log it once per request so the
    // operator can see why prose isn't appearing on the page.
    if (code === 'ENOENT') return null;
    if (code === 'ENOTDIR' || (err as NodeJS.ErrnoException)?.errno === -20) return null;

    console.warn(`[contentLoader] readFile failed for ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

// Set EXPLORER_CONTENT_DEBUG=1 in the env to log every article-load
// attempt — pair with a year-page request and the path the loader
// resolved should appear in the indexer/frontend logs. Useful when
// articles aren't appearing and you need to confirm the mount is live.
function debug(): boolean {
  return process.env.EXPLORER_CONTENT_DEBUG === '1';
}

export async function loadYearArticle(year: number): Promise<Frontmatter | null> {
  const file = path.join(CONTENT_DIR, 'blocks', 'years', `${year}.md`);
  const value = await loadArticleCached(file);
  if (debug()) {

    console.log(`[contentLoader] loadYearArticle(${year}) → ${file} ${value ? '(found)' : '(missing)'}`);
  }
  return value;
}

// Existence-only probe, same TTL as the article cache. Used by the
// year page to decide whether a *neighbour* year is a navigable page
// without reading + frontmatter-parsing its whole article (the result
// is only ever a boolean).
const existsCache = new Map<string, { value: boolean; expiresAt: number }>();
export async function hasYearArticle(year: number): Promise<boolean> {
  const file = path.join(CONTENT_DIR, 'blocks', 'years', `${year}.md`);
  const now = Date.now();
  const cached = existsCache.get(file);
  if (cached && cached.expiresAt > now) return cached.value;
  let value = false;
  try {
    value = (await fs.stat(file)).isFile();
  } catch {
    value = false;
  }
  existsCache.set(file, { value, expiresAt: now + ARTICLE_TTL_MS });
  return value;
}

export async function loadMonthArticle(year: number, month: number): Promise<Frontmatter | null> {
  const fm = `${year}-${String(month).padStart(2, '0')}`;
  const file = path.join(CONTENT_DIR, 'blocks', 'months', `${fm}.md`);
  return loadArticleCached(file);
}

export async function loadForkArticle(slug: string): Promise<Frontmatter | null> {
  const safe = slug.replace(/[^a-z0-9-]/gi, '');
  if (!safe) return null;
  const file = path.join(CONTENT_DIR, 'blocks', 'forks', `${safe}.md`);
  return loadArticleCached(file);
}
