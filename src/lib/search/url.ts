import { validateEventQuery, type EventQuery } from "./types";

// The query travels in the `q` search param as JSON. URLSearchParams handles
// percent-encoding when building the href; Next decodes it before the page reads
// searchParams, so decode only needs to JSON.parse + re-validate.

export function encodeEventQuery(query: EventQuery): string {
  return JSON.stringify(query);
}

export function decodeEventQuery(raw: string): EventQuery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("malformed search query");
  }
  return validateEventQuery(parsed);
}
