import type { GetServerSideProps } from 'next';
import { Seo } from '@/components/Seo';
import { DayArchive } from '../../../../routes/blocks/archive/DayArchive';
import { fetchDayArchive } from '../../../../routes/blocks/archive/fetch';
import type { DayArchiveData } from '../../../../routes/blocks/archive/types';

interface Props {
  data: DayArchiveData;
}

export default function DayPage({ data }: Props) {
  const { year, month, day } = data;
  return (
    <>
      <Seo
        title={`Blocks · ${year}-${month}-${day} · Gridcoin Block Explorer`}
        description={`Gridcoin blocks staked on ${year}-${month}-${day}.`}
        path={`/blocks/${year}/${month}/${day}`}
      />
      <DayArchive data={data} />
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const { year, month, day } = ctx.params ?? {};
  if (typeof year !== 'string' || typeof month !== 'string' || typeof day !== 'string') {
    return { notFound: true };
  }
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (!(y >= 2009 && y <= 2099)) return { notFound: true };
  if (!(m >= 1 && m <= 12)) return { notFound: true };
  if (!(d >= 1 && d <= 31)) return { notFound: true };

  const pageRaw = ctx.query.page;
  const page = Math.max(1, parseInt(typeof pageRaw === 'string' ? pageRaw : '1', 10) || 1);

  const data = await fetchDayArchive(y, m, d, page);
  if (!data) return { notFound: true };
  return { props: { data } };
};
