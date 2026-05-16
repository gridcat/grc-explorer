import { api, getAttributes, getDataList } from '../../../lib/api';
import type {
  YearArchiveData, MonthArchiveData, DayArchiveData,
} from './types';

// Thin SSR fetch helpers — every archive page calls one of these from
// getServerSideProps. Returning `null` on miss lets the page hand off
// to Next's `notFound: true` cleanly.

export async function fetchYearArchive(year: number): Promise<YearArchiveData | null> {
  try {
    return getAttributes<YearArchiveData>(await api.get(`/blocks/archive/${year}`));
  } catch {
    return null;
  }
}

export async function fetchMonthArchive(year: number, month: number): Promise<MonthArchiveData | null> {
  try {
    return getAttributes<MonthArchiveData>(
      await api.get(`/blocks/archive/${year}/${String(month).padStart(2, '0')}`),
    );
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
    return getAttributes<DayArchiveData>(r);
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
    return getDataList<YearListItem>(await api.get('/blocks/archive/years'));
  } catch {
    return [];
  }
}
