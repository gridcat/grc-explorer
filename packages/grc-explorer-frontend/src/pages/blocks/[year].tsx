import type { GetServerSideProps } from 'next';
import { Seo } from '@/components/Seo';
import { YearArchive } from '../../routes/blocks/archive/YearArchive';
import { fetchYearArchive, fetchYearList } from '../../routes/blocks/archive/fetch';
import type { YearArchiveData } from '../../routes/blocks/archive/types';
import { loadYearArticle, hasYearArticle } from '../../lib/contentLoader';

interface ArticleProps {
  data: Record<string, unknown>;
  body: string;
}

interface Props {
  data: YearArchiveData;
  prevYear: number | null;
  nextYear: number | null;
  article: ArticleProps | null;
}

export default function YearPage({
  data, prevYear, nextYear, article,
}: Props) {
  const { year } = data;
  return (
    <>
      <Seo
        title={`Blocks in ${year} · Gridcoin Block Explorer`}
        description={`Gridcoin blocks staked during ${year}, broken down by month and day.`}
        path={`/blocks/${year}`}
      />
      <YearArchive
        data={data}
        prevYear={prevYear}
        nextYear={nextYear}
        article={article}
      />
    </>
  );
}

function isYearShape(seg: string): boolean {
  if (!/^\d{4}$/.test(seg)) return false;
  const n = parseInt(seg, 10);
  return n >= 2009 && n <= 2099;
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const { year } = ctx.params ?? {};
  if (typeof year !== 'string') return { notFound: true };

  // Year-shape (4-digit, 2009-2099) → render year archive.
  // Anything else → permanent redirect to /block/<param>. This catches
  // legacy /blocks/<height> URLs out in the wild and points them at
  // their new canonical home — singular noun for the singular thing.
  // 308 (not 302) so search engines actually move the link equity.
  if (isYearShape(year)) {
    const yearNum = parseInt(year, 10);
    // Fetch the full year list in parallel so we can compute prev/next
    // arrows that point at years which actually have indexed data —
    // year-1 is wrong when (e.g.) 2013 has no blocks but 2014 does.
    const [data, list, article, prevHasArticle, nextHasArticle] = await Promise.all([
      fetchYearArchive(yearNum),
      fetchYearList(),
      loadYearArticle(yearNum),
      hasYearArticle(yearNum - 1),
      hasYearArticle(yearNum + 1),
    ]);
    if (!data) return { notFound: true };
    // Prev/next walk the full history range, not just data-years: a
    // year is a navigable page if it has indexed blocks OR an editorial
    // article (e.g. 2013 — Gridcoin Classic context — has an article
    // but no chain data, so list-only nav would orphan it). The chain
    // is contiguous, so a simple ±1 naturally yields no prev on the
    // earliest year and no next on the latest.
    const dataYears = new Set(list.map((y) => y.year));
    const prevYear = (dataYears.has(yearNum - 1) || prevHasArticle) ? yearNum - 1 : null;
    const nextYear = (dataYears.has(yearNum + 1) || nextHasArticle) ? yearNum + 1 : null;
    return {
      props: {
        data,
        prevYear,
        nextYear,
        article: article ? { data: article.data, body: article.body } : null,
      },
    };
  }

  return {
    redirect: {
      destination: `/block/${encodeURIComponent(year)}`,
      permanent: true,
    },
  };
};
