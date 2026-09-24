const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CUT_HOUR_UTC = 12;

export function latestDigestCut(now: number): number {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  const localMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - SHANGHAI_OFFSET_MS;
  const todayCut = localMidnightUtc + 20 * 60 * 60 * 1000;
  return now >= todayCut ? todayCut : todayCut - DAY_MS;
}

export function nextDigestCut(now: number): number {
  const latest = latestDigestCut(now);
  return latest > now ? latest : latest + DAY_MS;
}

export function previousDigestCut(cut: number): number {
  return cut - DAY_MS;
}

export function formatShanghai(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

export function dateLabelShanghai(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export const ONE_DAY_MS = DAY_MS;
export const RETENTION_MS = 7 * DAY_MS;
