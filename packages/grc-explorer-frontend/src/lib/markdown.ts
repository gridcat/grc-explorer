import {
  Fragment, createElement, type ReactNode,
} from 'react';
import { safeUrl } from './safeUrl';

/**
 * Minimal markdown → React-node renderer for explorer articles.
 *
 * Returns ReactNode[] directly so the caller can render with `{nodes}`
 * instead of injecting raw HTML — no innerHTML round-trip means the
 * XSS surface is zero, and internal links can use Next's <Link> if we
 * ever want client-side nav for them.
 *
 * Constrained-by-design — articles author to a known shape:
 *   - `# H1` `## H2` `### H3` headings
 *   - paragraphs separated by blank lines
 *   - `**bold**`, `*italic*`, `` `code` ``
 *   - `[label](url)` links
 *   - bullet lists (lines starting with `- `)
 *   - inline `{{stat:KEY}}` placeholders replaced by `stats[KEY]`
 *
 * No tables, no images, no fenced code blocks, no nested lists —
 * deliberately. Additions go through review so the article schema
 * stays small.
 */

export interface RenderOptions {
  /** Substituted into `{{stat:KEY}}` placeholders before parse. */
  stats?: Record<string, string | number>;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const LIST_RE = /^- (.*)$/;
const STAT_RE = /\{\{stat:([A-Za-z0-9_]+)\}\}/g;

export function renderMarkdown(src: string, opts: RenderOptions = {}): ReactNode[] {
  const stats = opts.stats ?? {};
  const expanded = src.replace(STAT_RE, (_, k) => {
    const v = stats[k];
    return v == null ? '—' : String(v);
  });

  const lines = expanded.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let listBuf: ReactNode[] | null = null;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    nodes.push(createElement('p', { key: `p${nodes.length}` }, ...renderInline(paraBuf.join(' '))));
    paraBuf = [];
  };
  const flushList = () => {
    if (listBuf === null) return;
    nodes.push(createElement('ul', { key: `ul${nodes.length}` }, ...listBuf));
    listBuf = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara(); flushList();
      const tag = `h${heading[1].length}`;
      nodes.push(createElement(tag, { key: `${tag}${nodes.length}` }, ...renderInline(heading[2])));
      continue;
    }
    const item = line.match(LIST_RE);
    if (item) {
      flushPara();
      if (listBuf === null) listBuf = [];
      listBuf.push(createElement('li', { key: `li${listBuf.length}` }, ...renderInline(item[1])));
      continue;
    }
    paraBuf.push(line);
  }
  flushPara(); flushList();
  return nodes;
}

// Inline tokenizer — splits a line into text runs + tagged spans
// (links, code, bold, italic). Non-overlapping; the first match wins
// at any given position. Regex ordering matters: code first (since
// `*` inside `code` shouldn't be parsed as bold), then links, then
// bold (must come before italic so `**` isn't eaten as `*`+italic).

interface InlineToken { kind: 'text' | 'code' | 'link' | 'bold' | 'italic'; raw: string; href?: string }

function tokenizeInline(s: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  const push = (kind: InlineToken['kind'], raw: string, href?: string): void => {
    tokens.push({ kind, raw, href });
  };
  while (i < s.length) {
    // Backtick code: `…`
    if (s[i] === '`') {
      const close = s.indexOf('`', i + 1);
      if (close > i) { push('code', s.slice(i + 1, close)); i = close + 1; continue; }
    }
    // Link: [label](url)
    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1);
      if (closeBracket > i && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket) {
          push('link', s.slice(i + 1, closeBracket), s.slice(closeBracket + 2, closeParen));
          i = closeParen + 1;
          continue;
        }
      }
    }
    // Bold: **…**
    if (s[i] === '*' && s[i + 1] === '*') {
      const close = s.indexOf('**', i + 2);
      if (close > i + 1) { push('bold', s.slice(i + 2, close)); i = close + 2; continue; }
    }
    // Italic: *…* (single asterisk, must not be part of **)
    if (s[i] === '*' && s[i + 1] !== '*') {
      const close = s.indexOf('*', i + 1);
      if (close > i && s[close - 1] !== '*' && s[close + 1] !== '*') {
        push('italic', s.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    // Plain text run — accumulate until the next special character.
    const next = nextSpecial(s, i);
    push('text', s.slice(i, next));
    i = next;
  }
  return tokens;
}

function nextSpecial(s: string, from: number): number {
  for (let k = from + 1; k < s.length; k += 1) {
    const c = s[k];
    if (c === '`' || c === '[' || c === '*') return k;
  }
  return s.length;
}

const DOFOLLOW_DOMAINS = /(^|\.)gridcoin\.us($|\/)|(^|\.)gridcoin\.club($|\/)|github\.com\/(gridcat|gridcoin-community)\//i;

function renderInline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const tokens = tokenizeInline(s);
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx];
    const key = `t${idx}`;
    switch (tok.kind) {
      case 'text':
        // Plain text — React auto-escapes when rendered.
        out.push(tok.raw);
        break;
      case 'code':
        out.push(createElement('code', { key }, tok.raw));
        break;
      case 'bold':
        out.push(createElement('strong', { key }, ...renderInline(tok.raw)));
        break;
      case 'italic':
        out.push(createElement('em', { key }, ...renderInline(tok.raw)));
        break;
      case 'link': {
        // Articles are author-controlled today, but defensive depth: run
        // every href through the allowlist so a future change wiring
        // user content into this renderer doesn't inherit a stored-XSS
        // hole. Dropped URLs degrade to a Fragment of the link's label —
        // the prose still reads, the click is gone.
        const safe = safeUrl(tok.href ?? '#');
        if (!safe) {
          out.push(createElement(Fragment, { key }, tok.raw));
          break;
        }
        const isExternal = /^https?:\/\//i.test(safe);
        const dofollow = isExternal && DOFOLLOW_DOMAINS.test(safe);
        const rel = isExternal && !dofollow ? 'nofollow noopener' : (isExternal ? 'noopener' : undefined);
        const target = isExternal ? '_blank' : undefined;
        out.push(createElement('a', {
          key,
          href: safe,
          target,
          rel,
        }, ...renderInline(tok.raw)));
        break;
      }
      default:
        out.push(createElement(Fragment, { key }, tok.raw));
    }
  }
  return out;
}
