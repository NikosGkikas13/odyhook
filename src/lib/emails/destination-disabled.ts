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
  // Strip control chars from the destination name before it lands in the
  // Subject header — defense-in-depth against header injection. The name
  // is set by the destination's owner (also the email recipient), so the
  // exposure is theoretical, but the sanitization is cheap.
  const safeName = input.destinationName.replace(/[\r\n\f]/g, "");
  return {
    subject: `Odyhook: destination "${safeName}" auto-disabled`,
    text: [
      `Heads up — Odyhook just auto-disabled your destination "${safeName}".`,
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
