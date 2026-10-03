import type { GetServerSideProps } from 'next';
import { clientHeaders, depthTtl, setPageCache } from '../../lib/ssr';
import { BlockDetail, fetchBlockDetailProps, type BlockDetailProps } from '../../routes/blocks/BlockDetail';

/**
 * Per-block canonical URL — `/block/<height>`.
 *
 * Convention: singular noun for ONE thing (Etherscan / mempool.space
 * style). The plural `/blocks/...` namespace is reserved for listings:
 * the live ticker and the dated archive (`/blocks/2024/03/15`). Old
 * `/blocks/<height>` URLs 301-redirect here from the year dispatcher.
 */
export default BlockDetail;

export const getServerSideProps: GetServerSideProps<BlockDetailProps> = async (ctx) => {
  const { height } = ctx.params ?? {};
  if (typeof height !== 'string') return { notFound: true };
  const props = await fetchBlockDetailProps(height, clientHeaders(ctx.req));
  if (!props) return { notFound: true };
  if (props.initialBlock && props.initialTipHeight !== null) {
    setPageCache(ctx.res, depthTtl(props.initialTipHeight - props.initialBlock.height));
  }
  return { props };
};
