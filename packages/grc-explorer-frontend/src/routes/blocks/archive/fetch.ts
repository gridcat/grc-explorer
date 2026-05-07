import { api } from '../../../lib/api';
import type {
  YearArchiveData, MonthArchiveData, DayArchiveData,
} from './types';

// Thin SSR fetch helpers — every archive page calls one of these from
// getServerSideProps. Returning `null` on miss lets the page hand off
// to Next's `notFound: true` cleanly.

export async function fetchYearArchive(year: number): Promise<YearArchiveData | null> {
  try {
    const r = await api.get(`/blocks/archive/${year}`);
    return (r.data?.data?.attributes ?? null) as YearArchiveData | null;
  } catch {
    return null;
  }
}

export async function fetchMonthArchive(year: number, month: number): Promise<MonthArchiveData | null> {
  try {
    const r = await api.get(`/blocks/archive/${year}/${String(month).padStart(2, '0')}`);
    return (r.data?.data?.attributes ?? null) as MonthArchiveData | null;
  } catch {
    return null;
  }
}

export async function fetchDayArchive(
  year: number, month: number, day: number, page: number = 1,
): Promise<DayArchiveData | null> {
  try {
    const r = await api.get(
      `/blocks/archive/${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
      { params: { 'page[number]': page } },
    );
    return (r.data?.data?.attributes ?? null) as DayArchiveData | null;
  } catch {
    return null;
  }
}

// Year list for the archive nav rail (rendered on /blocks landing).
export interface YearListItem {
  year: number;
  blockCount: number;
  txCount: number;
  superblockCount: number;
  valueMovedGrc: string;
}

export async function fetchYearList(): Promise<YearListItem[]> {
  try {
    const r = await api.get('/blocks/archive/years');
    const rows = (r.data?.data ?? []) as Array<{ attributes: YearListItem }>;
    return rows.map((row) => row.attributes);
  } catch {
    return [];
  }
}
