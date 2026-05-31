import { getConnection } from "./queue";

/** Shape pushed to listening CLIs — everything needed to replay locally. */
export type LiveEvent = {
  id: string;
  method: string;
  headersJson: Record<string, string>;
  bodyRaw: string;
  receivedAt: string;
};

/** Redis pub/sub channel carrying live events for one source. */
export function eventChannel(sourceId: string): string {
  return `events:${sourceId}`;
}

/**
 * Publish a newly-ingested event to its source channel. Fire-and-forget:
 * the caller must not let a publish failure affect ingest. Returns void and
 * swallows errors (logged) for that reason.
 */
export async function publishEvent(sourceId: string, evt: LiveEvent): Promise<void> {
  try {
    await getConnection().publish(eventChannel(sourceId), JSON.stringify(evt));
  } catch (err) {
    console.error("[events-pubsub] publish failed:", err);
  }
}
