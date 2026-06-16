// Wire shapes for /blocks/archive/* responses. Mirrors what
// blocksArchiveRouter sends; kept in the frontend so SSR fetch helpers
// and the rendering components share a single import.

export interface ArchivePeriodStats {
  blockCount: number;
  txCount: number;
  posCount: number;
  superblockCount: number;
  bytesTotal: number;
  mintTotalGrc: string;
  valueMovedGrc: string;
  feeTotalGrc: string;
  userTxCount: number;
}

export interface MonthSummary {
  month: number;
  blockCount: number;
  txCount: number;
  superblockCount: number;
  mintTotalGrc: string;
  valueMovedGrc: string;
  feeTotalGrc: string;
}

export interface DaySummary {
  day: number;
  blockCount: number;
  txCount: number;
  superblockCount: number;
  mintTotalGrc: string;
  valueMovedGrc: string;
  feeTotalGrc: string;
}

export interface ArchiveBlockRow {
  height: number;
  hash: string;
  time: number;
  version: number;
  size: number;
  txCount: number;
  isPos: boolean;
  isMrc: boolean;
  difficulty: number | string;
  minerAddress: string | null;
  stakerCpid: string | null;
  // Server-resolved BOINC display name for `stakerCpid` (archive is
  // SSR-static, so the name is baked in — no client-side useCpidNames).
  stakerName: string | null;
  isSuperblock: boolean;
  mintGrc: string;
  valueMoved: string;
  feeTotal: string;
}

export interface YearArchiveData extends ArchivePeriodStats {
  year: number;
  months: MonthSummary[];
}

export interface MonthArchiveData extends ArchivePeriodStats {
  year: number;
  month: number;
  days: DaySummary[];
}

export interface DayArchiveData extends ArchivePeriodStats {
  year: number;
  month: number;
  day: number;
  iso: string;
  blocks: ArchiveBlockRow[];
  pagination: { pageSize: number; pageNumber: number; totalPages: number };
}
