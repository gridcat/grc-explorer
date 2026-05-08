import {
  Box, IconButton, Paper, Tooltip, Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { styled, useTheme } from '@mui/material/styles';
import { Highlight, themes } from 'prism-react-renderer';
import {
  memo, useCallback, useMemo, useState,
} from 'react';

interface CodeBlockProps {
  code: string;
  /** Caption shown in the top bar. Omit to render only the floating copy button. */
  caption?: string;
  /** Prism language hint (e.g. "json", "bash", "ts"). Defaults to "text". */
  language?: string;
}
const Wrapper = styled(Paper)(({ theme }) => ({
  padding: 0,
  overflow: 'hidden',
  borderColor: theme.palette.divider,
  marginBottom: theme.spacing(2),
  position: 'relative',
}));

const CaptionBar = styled(Box)(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: theme.spacing(0.5, 1, 0.5, 2),
  minHeight: 36,
  borderBottom: `1px solid ${theme.palette.divider}`,
  backgroundColor: theme.palette.mode === 'dark'
    ? 'rgba(255, 255, 255, 0.03)'
    : 'rgba(0, 0, 0, 0.02)',
  gap: theme.spacing(1),
}));

const Pre = styled('pre')(({ theme }) => ({
  margin: 0,
  padding: theme.spacing(2),
  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  fontSize: '0.85rem',
  lineHeight: 1.55,
  overflowX: 'auto',
  whiteSpace: 'pre',
  backgroundColor: 'transparent',
  color: theme.palette.text.primary,
}));

const FloatingCopy = styled(Box)(({ theme }) => ({
  position: 'absolute',
  top: theme.spacing(0.5),
  right: theme.spacing(0.5),
  zIndex: 1,
}));

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context, denied permission) */
    }
  }, [code]);
  return (
    <Tooltip title={copied ? 'Copied!' : 'Copy'} placement="left">
      <IconButton
        size="small"
        onClick={handleCopy}
        aria-label="Copy code to clipboard"
        sx={{ color: copied ? 'success.main' : 'text.secondary' }}
      >
        {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}

function CodeBlockInner({ code, caption, language = 'text' }: CodeBlockProps) {
  const theme = useTheme();
  const prismTheme = theme.palette.mode === 'dark' ? themes.vsDark : themes.github;
  // Trim leading/trailing newlines so authors can use template literals
  // with cosmetic indentation without breaking the visible block.
  const trimmed = useMemo(() => code.replace(/^\n+|\n+$/g, ''), [code]);
  return (
    <Wrapper variant="outlined" elevation={0}>
      {caption ? (
        <CaptionBar>
          <Typography
            variant="caption"
            sx={{
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 600,
              color: 'text.secondary',
            }}
          >
            {language && language !== 'text' ? `${caption} · ${language}` : caption}
          </Typography>
          <CopyButton code={trimmed} />
        </CaptionBar>
      ) : (
        <FloatingCopy>
          <CopyButton code={trimmed} />
        </FloatingCopy>
      )}
      <Highlight theme={prismTheme} code={trimmed} language={language}>
        {({
          style, tokens, getLineProps, getTokenProps,
        }) => (
          <Pre style={{ ...style, backgroundColor: 'transparent' }}>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (

                <div key={i} {...lineProps}>
                  {line.map((token, j) => {
                    const tokenProps = getTokenProps({ token });

                    return <span key={j} {...tokenProps} />;
                  })}
                </div>
              );
            })}
          </Pre>
        )}
      </Highlight>
    </Wrapper>
  );
}

export const CodeBlock = memo(CodeBlockInner);
