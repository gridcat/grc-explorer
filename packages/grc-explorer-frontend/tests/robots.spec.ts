import type { GetServerSidePropsContext } from 'next';
import { getServerSideProps, CRAWL_DELAY, AI_CRAWL_DELAY } from '../src/pages/robots.txt';

/** Minimal GetServerSideProps context — just the bits robots.txt reads. */
async function renderRobots(headers: Record<string, string> = {}): Promise<string> {
  let body = '';
  const ctx = {
    req: { headers, socket: {} },
    res: {
      setHeader: () => undefined,
      write: (chunk: string) => { body += chunk; },
      end: () => undefined,
    },
  } as unknown as GetServerSidePropsContext;
  await getServerSideProps(ctx);
  return body;
}

/**
 * Split robots.txt into groups. A group is a run of User-agent lines
 * followed by its rules — which is the whole point of the parse: a
 * crawler obeys one group and inherits nothing from `*`.
 */
function parseGroups(body: string): { agents: string[]; rules: string[] }[] {
  const groups: { agents: string[]; rules: string[] }[] = [];
  let current: { agents: string[]; rules: string[] } | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (field.toLowerCase() === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
    } else if (current) {
      current.rules.push(line);
    }
  }
  return groups;
}

describe('robots.txt groups', () => {
  let body: string;
  let wildcard: { agents: string[]; rules: string[] } | undefined;
  let ai: { agents: string[]; rules: string[] } | undefined;
  let allGroups: { agents: string[]; rules: string[] }[];

  beforeAll(async () => {
    body = await renderRobots({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'explorer.gridcoin.club' });
    allGroups = parseGroups(body);
    wildcard = allGroups.find((g) => g.agents.includes('*'));
    ai = allGroups.find((g) => g.agents.includes('GPTBot'));
  });

  it('throttles the catch-all group', () => {
    expect(wildcard?.rules).toContain(`Crawl-delay: ${CRAWL_DELAY}`);
  });

  it('gives AI crawlers their own slower group', () => {
    expect(ai).toBeDefined();
    expect(ai).not.toBe(wildcard);
    expect(ai?.rules).toContain(`Crawl-delay: ${AI_CRAWL_DELAY}`);
  });

  it('lists every AI crawler in that one group', () => {
    for (const ua of ['ClaudeBot', 'PerplexityBot', 'CCBot', 'Bytespider', 'Amazonbot']) {
      expect(ai?.agents).toContain(ua);
    }
  });

  it('restates the Disallow rules in the AI group', () => {
    // Groups don't inherit: an agent matched here never reads `*`, so
    // dropping these would silently re-open the crawl traps.
    for (const rule of ['Disallow: /*?page=', 'Disallow: /search']) {
      expect(wildcard?.rules).toContain(rule);
      expect(ai?.rules).toContain(rule);
    }
  });

  it('keeps the site allowed in both groups', () => {
    expect(wildcard?.rules).toContain('Allow: /');
    expect(ai?.rules).toContain('Allow: /');
  });

  it('throttles every Meta fetcher rather than blocking it', () => {
    // Meta stays crawlable — blocking facebookexternalhit would kill the
    // link preview on every shared explorer URL.
    for (const ua of ['facebookexternalhit', 'meta-externalagent', 'Meta-ExternalFetcher', 'FacebookBot']) {
      expect(ai?.agents).toContain(ua);
    }
    expect(body).not.toMatch(/^Disallow: \/$/m);
  });

  it('never lists one agent in two groups', () => {
    // Two groups matching the same agent is undefined behaviour — the
    // crawler picks one and the other silently does nothing.
    const seen = allGroups.flatMap((g) => g.agents.map((a) => a.toLowerCase()));
    expect(seen).toHaveLength(new Set(seen).size);
  });

  it('points sitemap and llms.txt at the forwarded origin', () => {
    expect(body).toContain('Sitemap: https://explorer.gridcoin.club/sitemap.xml');
    expect(body).toContain('llms.txt: https://explorer.gridcoin.club/llms.txt');
  });
});
