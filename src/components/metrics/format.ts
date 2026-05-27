export function formatTimestamp(value: number | string): string {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
