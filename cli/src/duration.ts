const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration like "30s", "5m", "2h", "1d" into milliseconds. */
export function parseDuration(input: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2]];
}
