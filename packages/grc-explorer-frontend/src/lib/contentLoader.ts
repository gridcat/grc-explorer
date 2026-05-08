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

function contentDir(): string {
  const fromEnv = process.env.EXPLORER_CONTENT_DIR;
  if (fromEnv) return fromEnv;
  // Dev fallback: ../grc-explorer-content from process.cwd(), which
  // is the frontend package dir under both `npm run dev` and the
  // Docker bind-mount layout.
  return path.resolve(process.cwd(), '..', 'grc-explorer-content');
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
  const file = path.join(contentDir(), 'blocks', 'years', `${year}.md`);
  const raw = await readIfExists(file);
  if (debug()) {

    console.log(`[contentLoader] loadYearArticle(${year}) → ${file} ${raw ? '(found)' : '(missing)'}`);
  }
  return raw ? parseFrontmatter(raw) : null;
}

export async function loadMonthArticle(year: number, month: number): Promise<Frontmatter | null> {
  const fm = `${year}-${String(month).padStart(2, '0')}`;
  const file = path.join(contentDir(), 'blocks', 'months', `${fm}.md`);
  const raw = await readIfExists(file);
  return raw ? parseFrontmatter(raw) : null;
}

export async function loadForkArticle(slug: string): Promise<Frontmatter | null> {
  const safe = slug.replace(/[^a-z0-9-]/gi, '');
  if (!safe) return null;
  const file = path.join(contentDir(), 'blocks', 'forks', `${safe}.md`);
  const raw = await readIfExists(file);
  return raw ? parseFrontmatter(raw) : null;
}
