// Redis-backed token-bucket rate limiter.
//
// One bucket per source, keyed by `rl:src:<sourceId>`. The bucket is refilled
// at `refillPerSec` tokens per second up to `capacity` tokens. Each ingest
// consumes one token. When the bucket is empty we return { allowed: false }
// along with a `retryAfterSec` hint for the HTTP response.
//
// The check + refill + decrement happens inside a single Lua script so it's
// atomic across concurrent workers / Next.js server instances. Without Lua
// we'd have a classic check-then-set race where two concurrent requests both
// observe a full bucket and both decrement to `capacity - 1`.

import { getConnection } from "./queue";

// Stored as a hash with two fields: `tokens` (float) and `ts` (ms epoch).
// KEYS[1] = bucket key
// ARGV[1] = capacity (int)
// ARGV[2] = refillPerSec (float)
// ARGV[3] = now (ms epoch)
// ARGV[4] = ttl seconds (int) — key expiry so idle buckets don't accumulate
//
// Returns: { allowed (0/1), tokensRemaining (float), retryAfterMs (int) }
const LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local data = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill based on elapsed time.
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retryAfterMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  -- How long until we have 1 token?
  local needed = 1 - tokens
  if refill > 0 then
    retryAfterMs = math.ceil((needed / refill) * 1000)
  else
    retryAfterMs = 1000
  end
end

redis.call("HMSET", key, "tokens", tokens, "ts", now)
redis.call("EXPIRE", key, ttl)

return { allowed, tostring(tokens), retryAfterMs }
`;

export type RateLimitResult = {
  allowed: boolean;
  tokensRemaining: number;
  retryAfterMs: number;
};

export type RateLimitConfig = {
  /** Sustained refill rate in tokens per second. */
  refillPerSec: number;
  /** Maximum bucket capacity (burst size). */
  capacity: number;
};

/**
 * Env-driven defaults. Override in production via:
 *   RATE_LIMIT_PER_SEC  (default: 10)
 *   RATE_LIMIT_BURST    (default: 20)
 */
export function defaultConfig(): RateLimitConfig {
  const refill = Number(process.env.RATE_LIMIT_PER_SEC ?? 10);
  const burst = Number(process.env.RATE_LIMIT_BURST ?? 20);
  return {
    refillPerSec: Number.isFinite(refill) && refill > 0 ? refill : 10,
    capacity: Number.isFinite(burst) && burst > 0 ? burst : 20,
  };
}

// ── Redis-independent fallback ──────────────────────────────────────────────
// The Redis token bucket is the only request-rate control, and every call site
// fails open if it throws — so any Redis disruption removes all rate limiting
// at once. To keep a coarse ceiling during an outage we mirror the bucket in
// process memory and consume from it whenever the Lua call fails. It's per
// instance (not shared) and bounded in size, but it stops the limiter from
// vanishing entirely when it's needed most.
const FALLBACK_MAX_BUCKETS = 10_000;
const fallbackBuckets = new Map<string, { tokens: number; ts: number }>();

/**
 * Process-local token bucket with the same refill semantics as the Lua script.
 * `now` is injectable for tests; production passes Date.now().
 */
export function checkFallbackLimit(
  key: string,
  cfg: RateLimitConfig,
  now: number = Date.now(),
): RateLimitResult {
  let bucket = fallbackBuckets.get(key);
  if (!bucket) {
    // Bound memory: evict the oldest-inserted bucket once we hit the cap.
    if (fallbackBuckets.size >= FALLBACK_MAX_BUCKETS) {
      const oldest = fallbackBuckets.keys().next().value;
      if (oldest !== undefined) fallbackBuckets.delete(oldest);
    }
    bucket = { tokens: cfg.capacity, ts: now };
    fallbackBuckets.set(key, bucket);
  }

  const elapsed = Math.max(0, now - bucket.ts) / 1000;
  bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsed * cfg.refillPerSec);
  bucket.ts = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, tokensRemaining: bucket.tokens, retryAfterMs: 0 };
  }
  const needed = 1 - bucket.tokens;
  const retryAfterMs =
    cfg.refillPerSec > 0 ? Math.ceil((needed / cfg.refillPerSec) * 1000) : 1000;
  return { allowed: false, tokensRemaining: bucket.tokens, retryAfterMs };
}

async function consumeToken(
  key: string,
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  // TTL = time to refill a full bucket from empty, plus a small buffer.
  const ttlSec = Math.max(
    60,
    Math.ceil(cfg.capacity / Math.max(cfg.refillPerSec, 0.01)) + 60,
  );

  try {
    const conn = getConnection();
    const raw = (await conn.eval(
      LUA_SCRIPT,
      1,
      key,
      String(Math.floor(cfg.capacity)),
      String(cfg.refillPerSec),
      String(Date.now()),
      String(ttlSec),
    )) as [number, string, number];

    return {
      allowed: raw[0] === 1,
      tokensRemaining: Number(raw[1]),
      retryAfterMs: Number(raw[2]),
    };
  } catch (err) {
    // Redis unavailable: don't fail fully open — enforce the process-local
    // backstop so flooding during an outage is still bounded.
    console.error("[ratelimit] Redis limiter failed; using in-process fallback:", err);
    return checkFallbackLimit(key, cfg);
  }
}

/**
 * Check and decrement a bucket. Returns whether the caller is allowed through
 * and, on rejection, how long to wait before retrying.
 */
export async function checkRateLimit(
  sourceId: string,
  cfg: RateLimitConfig = defaultConfig(),
): Promise<RateLimitResult> {
  return consumeToken(`rl:src:${sourceId}`, cfg);
}

/**
 * Per-user rate limit for the replay endpoint. An authed user can otherwise
 * loop the replay button (or scripted equivalent) and saturate the worker.
 * Defaults are tighter than ingest because replay is human-driven; override
 * via REPLAY_RATE_LIMIT_PER_SEC / REPLAY_RATE_LIMIT_BURST.
 */
export function defaultReplayConfig(): RateLimitConfig {
  const refill = Number(process.env.REPLAY_RATE_LIMIT_PER_SEC ?? 1);
  const burst = Number(process.env.REPLAY_RATE_LIMIT_BURST ?? 10);
  return {
    refillPerSec: Number.isFinite(refill) && refill > 0 ? refill : 1,
    capacity: Number.isFinite(burst) && burst > 0 ? burst : 10,
  };
}

export async function checkReplayRateLimit(
  userId: string,
  cfg: RateLimitConfig = defaultReplayConfig(),
): Promise<RateLimitResult> {
  return consumeToken(`rl:replay:${userId}`, cfg);
}

/**
 * Merge a per-source override with the env default. `null` fields on the
 * override fall through to the default.
 */
export function configForSource(source: {
  rateLimitPerSec: number | null;
  rateLimitBurst: number | null;
}): RateLimitConfig {
  const def = defaultConfig();
  return {
    refillPerSec:
      source.rateLimitPerSec != null && source.rateLimitPerSec > 0
        ? source.rateLimitPerSec
        : def.refillPerSec,
    capacity:
      source.rateLimitBurst != null && source.rateLimitBurst > 0
        ? source.rateLimitBurst
        : def.capacity,
  };
}

/**
 * Per-API-token rate limit for the public REST API. Keyed on the token id so a
 * single runaway script can't saturate the API. Override via
 * API_RATE_LIMIT_PER_SEC / API_RATE_LIMIT_BURST.
 */
export function defaultApiConfig(): RateLimitConfig {
  const refill = Number(process.env.API_RATE_LIMIT_PER_SEC ?? 10);
  const burst = Number(process.env.API_RATE_LIMIT_BURST ?? 30);
  return {
    refillPerSec: Number.isFinite(refill) && refill > 0 ? refill : 10,
    capacity: Number.isFinite(burst) && burst > 0 ? burst : 30,
  };
}

export async function checkApiRateLimit(
  tokenId: string,
  cfg: RateLimitConfig = defaultApiConfig(),
): Promise<RateLimitResult> {
  return consumeToken(`rl:api:${tokenId}`, cfg);
}

/**
 * Per-user limit for the "send test alert" action — each call fires an outbound
 * fetch, so it needs a throttle. Tight by default; override via
 * TEST_ALERT_RATE_LIMIT_PER_SEC / TEST_ALERT_RATE_LIMIT_BURST.
 */
export function defaultTestAlertConfig(): RateLimitConfig {
  const refill = Number(process.env.TEST_ALERT_RATE_LIMIT_PER_SEC ?? 0.2);
  const burst = Number(process.env.TEST_ALERT_RATE_LIMIT_BURST ?? 5);
  return {
    refillPerSec: Number.isFinite(refill) && refill > 0 ? refill : 0.2,
    capacity: Number.isFinite(burst) && burst > 0 ? burst : 5,
  };
}

export async function checkTestAlertRateLimit(
  userId: string,
  cfg: RateLimitConfig = defaultTestAlertConfig(),
): Promise<RateLimitResult> {
  return consumeToken(`rl:testalert:${userId}`, cfg);
}
