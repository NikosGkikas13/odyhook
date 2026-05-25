// Email composed when the circuit breaker trips on a destination.
// Kept separate from the sending code so the body can be unit-tested
// without an SMTP server.

export type DestinationDisabledInput = {
  destinationName: string;
  reason: string;
  consecutiveFailures: number;
};

export type ComposedMessage = {
  subject: string;
  text: string;
};

export function composeDestinationDisabledEmail(
  input: DestinationDisabledInput,
): ComposedMessage {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const link = `${baseUrl}/destinations`;
  const reason = input.reason.slice(0, 300);
  return {
    subject: `Odyhook: destination "${input.destinationName}" auto-disabled`,
    text: [
      `Heads up — Odyhook just auto-disabled your destination "${input.destinationName}".`,
      "",
      `Reason: ${input.consecutiveFailures} consecutive deliveries exhausted their retries.`,
      `Last error: ${reason}`,
      "",
      "No more events will be sent to this destination until you resume it.",
      "Any events that arrive while it's disabled are marked exhausted with",
      `"destination paused" so you can replay them after resuming.`,
      "",
      `Resume here: ${link}`,
    ].join("\n"),
  };
}
