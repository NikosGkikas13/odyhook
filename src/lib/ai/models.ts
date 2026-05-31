// Anthropic model ids. Kept in a dependency-free leaf module so pure logic
// (and its unit tests) can import them without pulling in the DB client.
// Override via env in production if needed.
export const MODEL_DEFAULT = "claude-sonnet-4-6";
export const MODEL_CHEAP = "claude-haiku-4-5-20251001";
