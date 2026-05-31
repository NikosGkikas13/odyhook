import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";
import { getConnection } from "./queue";
import { publishEvent, eventChannel, type LiveEvent } from "./events-pubsub";

afterAll(async () => {
  await getConnection().quit();
});

describe("publishEvent", () => {
  it("publishes a JSON event to the source channel", async () => {
    const sub = getConnection().duplicate();
    const sourceId = "src_test_" + Date.now();
    const received = new Promise<LiveEvent>((resolve) => {
      sub.on("message", (_chan, msg) => resolve(JSON.parse(msg)));
    });
    await sub.subscribe(eventChannel(sourceId));

    const evt: LiveEvent = {
      id: "evt_1",
      method: "POST",
      headersJson: { "content-type": "application/json" },
      bodyRaw: "{}",
      receivedAt: new Date().toISOString(),
    };
    await publishEvent(sourceId, evt);

    expect(await received).toEqual(evt);
    await sub.quit();
  });
});
