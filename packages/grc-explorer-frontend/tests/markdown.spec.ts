import { isValidElement, type ReactNode } from 'react';
import { renderMarkdown } from '../src/lib/markdown';

// Walk the ReactNode[] tree renderMarkdown emits (plain element
// objects, no DOM needed) and collect every <a> element's props.
function collectAnchors(nodes: ReactNode[]): Array<{ href?: string; rel?: string; target?: string }> {
  const out: Array<{ href?: string; rel?: string; target?: string }> = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!isValidElement(n)) return;
    const el = n as { type: unknown; props: Record<string, unknown> };
    if (el.type === 'a') {
      out.push({
        href: el.props.href as string | undefined,
        rel: el.props.rel as string | undefined,
        target: el.props.target as string | undefined,
      });
    }
    if (el.props && 'children' in el.props) visit(el.props.children as ReactNode);
  };
  nodes.forEach(visit);
  return out;
}

const firstAnchor = (md: string) => collectAnchors(renderMarkdown(md))[0];

describe('renderMarkdown link rel policy', () => {
  it('marks [^label](url) citations nofollow+noreferrer even on a dofollow domain', () => {
    const a = firstAnchor('See [^source](https://github.com/gridcoin-community/Gridcoin-Research).');
    expect(a.href).toBe('https://github.com/gridcoin-community/Gridcoin-Research');
    expect(a.rel).toBe('nofollow noopener noreferrer');
    expect(a.target).toBe('_blank');
  });

  it('strips the leading caret from the rendered citation label', () => {
    const nodes = renderMarkdown('[^Gridcoin release notes](https://gridcoin.us)');
    // The anchor child is the label sans caret.
    const json = JSON.stringify(nodes);
    expect(json).toContain('Gridcoin release notes');
    expect(json).not.toContain('^Gridcoin release notes');
  });

  it('keeps ordinary family links dofollow (noopener, no nofollow)', () => {
    const a = firstAnchor('Built on [Gridcoin Research](https://github.com/gridcoin-community/Gridcoin-Research).');
    expect(a.rel).toBe('noopener');
  });

  it('still nofollows ordinary non-allowlisted external links', () => {
    const a = firstAnchor('Per [Wikipedia](https://en.wikipedia.org/wiki/Gridcoin).');
    expect(a.rel).toBe('nofollow noopener');
  });

  it('leaves internal links unadorned (no rel, no target)', () => {
    const a = firstAnchor('See [the 2020 page](/blocks/2020).');
    expect(a.href).toBe('/blocks/2020');
    expect(a.rel).toBeUndefined();
    expect(a.target).toBeUndefined();
  });
});
