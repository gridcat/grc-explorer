import * as React from 'react';

interface Props extends React.HTMLAttributes<HTMLSpanElement> {
  text: string;
  /** Characters to keep at full size at the start. Default 10. */
  head?: number;
  /** Characters to keep at full size at the end. Default 6. */
  tail?: number;
}

/**
 * Visually-truncated hash / address that copies in full. The middle
 * characters are rendered at a tiny font with reduced opacity so they
 * read as a "smudge" indistinguishable from `…`, but they're still
 * present in the DOM — selecting and copying the rendered span yields
 * the original string verbatim.
 *
 * Why not the simpler `head…tail`: a literal ellipsis can't be
 * round-tripped on copy, which is the most common reason users hit
 * this on an explorer ("let me grab this txid"). The smudge keeps the
 * compact look without breaking copy.
 */
export function HashTrim({
  text, head = 10, tail = 6, style, ...rest
}: Props) {
  // Single render path for both short and long strings keeps the SSR
  // markup identical to the CSR render — earlier the `text.length <=
  // head + tail + 1` early-return produced a different outer span (no
  // title, no whiteSpace nowrap), which only sometimes triggered a
  // hydration mismatch depending on the parent context.
  const showSmudge = !!text && text.length > head + tail + 1;
  const front = showSmudge ? text.slice(0, head) : (text ?? '');
  const middle = showSmudge ? text.slice(head, text.length - tail) : '';
  const back = showSmudge ? text.slice(-tail) : '';
  return (
    <span
      {...rest}
      style={{ whiteSpace: 'nowrap', ...style }}
      title={text}
    >
      {front}
      {showSmudge && (
        <span
          // Decorative-only inner span. `verticalAlign: middle` was
          // dropped here because React-19/dev-mode hydration sometimes
          // serialised it as SVG `alignment-baseline`, producing a
          // divergent client tree. The small font + lineHeight: 1
          // already keeps the smudge on the surrounding baseline.
          style={{
            fontSize: '0.42em',
            letterSpacing: '-0.04em',
            opacity: 0.5,
            lineHeight: 1,
          }}
        >
          {middle}
        </span>
      )}
      {back}
    </span>
  );
}
