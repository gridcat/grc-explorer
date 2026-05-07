import createEmotionServer from '@emotion/server/create-instance';
import Document, {
  DocumentContext, DocumentProps, Head, Html, Main, NextScript,
} from 'next/document';
import * as React from 'react';
import createEmotionCache from '../createEmotionCache';

// Emotion's SSR contract requires injecting the extracted critical CSS
// via dangerouslySetInnerHTML. The CSS comes from emotion's own style
// cache (a server-controlled source after we render our trusted React
// tree), not from user input — there is no XSS surface here. This is
// the canonical MUI 5/6 + emotion SSR setup recommended by both
// projects' docs.

interface ExplorerDocumentProps extends DocumentProps {
  themeMode: 'light' | 'dark';
}

export default class MyDocument extends Document<ExplorerDocumentProps> {
  render() {
    const { themeMode } = this.props;
    const initialBg = themeMode === 'dark' ? '#101418' : '#f8fafd';
    return (
      <Html lang="en" data-scroll-behavior="smooth" data-theme={themeMode}>
        <Head>
          <link rel="dns-prefetch" href="https://daj.pw" />
          <link rel="preconnect" href="https://daj.pw" crossOrigin="anonymous" />
          <meta name="theme-color" content={initialBg} />
          {/*
            FOUC-prevention: a <style> block (NOT inline `style=` on
            <body>) with the same selector specificity as emotion's
            MuiCssBaseline override. Both target `body { background-color }`
            at specificity (0,0,0,1); emotion's stylesheet loads later
            during hydration and wins the cascade, so toggling the theme
            after hydration swaps the bg instantly. Inline `style=` would
            be specificity (1,0,0,0) and lock the color forever — that
            was the toggle bug.
          */}
          <style
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: `body{background-color:${initialBg};margin:0;}`,
            }}
          />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

MyDocument.getInitialProps = async (ctx: DocumentContext) => {
  const originalRenderPage = ctx.renderPage;
  const cache = createEmotionCache();
  const { extractCriticalToChunks } = createEmotionServer(cache);

  ctx.renderPage = () => originalRenderPage({
    enhanceApp: (App: any) => (props) => <App emotionCache={cache} {...props} />,
  });

  const initialProps = await Document.getInitialProps(ctx);
  const emotionStyles = extractCriticalToChunks(initialProps.html);
  // eslint-disable-next-line react/no-danger -- emotion SSR requires this; CSS is server-generated, not user input
  const emotionStyleTags = emotionStyles.styles.map((style) => (
    <style
      data-emotion={`${style.key} ${style.ids.join(' ')}`}
      key={style.key}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: style.css }}
    />
  ));

  // Read the theme cookie SSR-side so the <html data-theme> attribute
  // is set on the very first paint — no light-flash on dark-mode reload.
  let themeMode: 'light' | 'dark' = 'light';
  const cookieHeader = ctx.req?.headers?.cookie;
  if (typeof cookieHeader === 'string') {
    const m = cookieHeader.match(/(?:^|;\s*)theme=(dark|light)/);
    if (m) themeMode = m[1] as 'light' | 'dark';
  }

  return {
    ...initialProps,
    styles: [...React.Children.toArray(initialProps.styles), ...emotionStyleTags],
    themeMode,
  };
};
