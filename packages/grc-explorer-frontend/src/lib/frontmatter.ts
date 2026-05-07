/**
 * Tiny YAML-frontmatter parser for the article markdown files in
 * grc-explorer-content. Only supports the shapes we actually emit:
 *   - top-level scalar keys      (year: 2018)
 *   - top-level string values    (summary: "...")
 *   - simple lists of objects    (releases: [{...}, {...}])
 *
 * Avoids a `gray-matter` dependency on purpose — articles are
 * authored to a constrained schema and a 60-line parser is easier
 * to audit + diff than a 200KB npm package. If we ever need full
 * YAML (anchors, multi-line strings, etc.), swap to gray-matter.
 */

export interface Frontmatter {
  /** Raw frontmatter as `key → unknown`. Caller knows the per-article shape. */
  data: Record<string, unknown>;
  /** Markdown body sans frontmatter, trimmed. */
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): Frontmatter {
  const m = raw.match(FENCE);
  if (!m) return { data: {}, body: raw.trim() };
  const fmText = m[1];
  const body = m[2].trim();
  return { data: parseYamlSubset(fmText), body };
}

/**
 * Tiny YAML-ish parser. Lines like `key: value` become string entries;
 * `key: 2018` becomes a number; lists open as `key:` followed by
 * `  - { … }` or `  - value` rows. Inline {…} objects are parsed as
 * a JSON-with-trailing-commas-tolerated subset — sufficient for the
 * release / landmark / source records the article schema uses.
 */
function parseYamlSubset(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i += 1; continue; }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) { i += 1; continue; }
    const key = kv[1];
    const rest = kv[2];
    if (rest.length === 0) {
      // List or empty. Peek ahead for indented `-` rows.
      const items: unknown[] = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
        i += 1;
        const itemBody = lines[i].replace(/^\s+-\s/, '').trim();
        items.push(parseScalarOrInline(itemBody));
      }
      out[key] = items;
    } else {
      out[key] = parseScalarOrInline(rest);
    }
    i += 1;
  }
  return out;
}

function parseScalarOrInline(text: string): unknown {
  const t = text.trim();
  if (!t) return '';
  // Inline object: { foo: "bar", baz: 1 }
  if (t.startsWith('{') && t.endsWith('}')) {
    return parseInlineObject(t);
  }
  // Quoted string.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  // Number.
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  return t;
}

function parseInlineObject(text: string): Record<string, unknown> {
  // Strip braces.
  const inner = text.slice(1, -1);
  const out: Record<string, unknown> = {};
  // Split on commas not inside quotes. Articles have simple inline
  // shapes so a quote-state tokenizer is enough.
  const tokens: string[] = [];
  let depth = 0;
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch as '"' | "'"; buf += ch; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      tokens.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) tokens.push(buf);
  for (const tok of tokens) {
    const m = tok.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = parseScalarOrInline(m[2]);
  }
  return out;
}
