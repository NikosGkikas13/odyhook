/** Parse an ISO timestamp string, throwing a descriptive error on invalid input. */
export function toDate(label: string, value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ${label} timestamp: ${value}`);
  return d;
}
