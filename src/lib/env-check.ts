// Boot-time guard against shipping placeholder secrets to production.
//
// .env.example carries obvious "replace-me" values; copying one into a real
// deployment (e.g. ENCRYPTION_KEY) is catastrophic (every encrypted column
// becomes unrecoverable / forgeable). Fail fast at startup rather than run with
// a known-bad secret. Called from instrumentation (web) and the worker.

const PLACEHOLDER_RE = /replace[-_]?me|changeme|placeholder|example|your[-_]?secret/i;

// Secrets that must be real in production, with a minimum length.
const REQUIRED: Array<{ name: string; minLen: number }> = [
  { name: "AUTH_SECRET", minLen: 16 },
  { name: "ENCRYPTION_KEY", minLen: 16 },
];

export function assertProdSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  for (const { name, minLen } of REQUIRED) {
    const value = env[name];
    if (!value || value.length < minLen) {
      throw new Error(
        `${name} is missing or too short in production (need >= ${minLen} chars)`,
      );
    }
    if (PLACEHOLDER_RE.test(value)) {
      throw new Error(
        `${name} looks like a placeholder value in production — set a real secret`,
      );
    }
  }
}
