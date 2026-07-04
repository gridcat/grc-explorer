import type { GetServerSideProps } from 'next';
import { Seo } from '@/components/Seo';
import { MonthArchive } from '../../../../routes/blocks/archive/MonthArchive';
import { fetchMonthArchive } from '../../../../routes/blocks/archive/fetch';
import type { MonthArchiveData } from '../../../../routes/blocks/archive/types';

interface Props {
  data: MonthArchiveData;
}

export default function MonthPage({ data }: Props) {
  const { year, month } = data;
  return (
    <>
      <Seo
        title={`Blocks · ${year}-${month} · Gridcoin Block Explorer`}
        description={`Gridcoin blocks staked in ${year}-${month}, by day.`}
        path={`/blocks/${year}/${month}`}
      />
      <MonthArchive data={data} />
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const { year, month } = ctx.params ?? {};
  if (typeof year !== 'string' || typeof month !== 'string') return { notFound: true };
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!(y >= 2009 && y <= 2099)) return { notFound: true };
  if (!(m >= 1 && m <= 12)) return { notFound: true };

  const data = await fetchMonthArchive(y, m);
  if (!data) return { notFound: true };
  return { props: { data } };
};
