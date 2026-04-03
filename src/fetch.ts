// --- Resilient Fetch Middleware ---
// Handles 429 retry with backoff, 401/403 token refresh, 5xx retry,
// and Antigravity endpoint fallback.

export interface ResilientFetchOptions {
  maxRetries?: number; // default 3
  initialDelayMs?: number; // default 2000
  maxDelayMs?: number; // default 30000
  backoffFactor?: number; // default 2
  refreshToken?: () => Promise<string | null>; // returns new access token, or null if refresh fails
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;

  // Try as seconds
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try as HTTP date
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delayMs = date - Date.now();
    return delayMs > 0 ? delayMs : null;
  }

  return null;
}

function computeBackoff(
  attempt: number,
  initialDelayMs: number,
  backoffFactor: number,
  maxDelayMs: number
): number {
  const delay = initialDelayMs * Math.pow(backoffFactor, attempt);
  return Math.min(delay, maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resilientFetch(
  url: string | URL,
  init: RequestInit,
  options?: ResilientFetchOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 2000;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const backoffFactor = options?.backoffFactor ?? 2;

  let lastError: Error | null = null;
  let refreshAttempted = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);

      // 429 Too Many Requests — retry with backoff
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        const delayMs =
          retryAfterMs ??
          computeBackoff(attempt, initialDelayMs, backoffFactor, maxDelayMs);

        console.error(
          `[brainstew] 429 from ${typeof url === "string" ? url : url.toString()}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await sleep(delayMs);
        continue;
      }

      // 401/403 — try token refresh once
      if (
        (res.status === 401 || res.status === 403) &&
        !refreshAttempted &&
        options?.refreshToken
      ) {
        refreshAttempted = true;
        const newToken = await options.refreshToken();
        if (newToken) {
          // Clone init with updated Authorization header
          const newHeaders = new Headers(init.headers);
          newHeaders.set("Authorization", `Bearer ${newToken}`);
          init = { ...init, headers: newHeaders };
          continue;
        }
      }

      // 5xx Server Error — retry with backoff
      if (res.status >= 500 && attempt < maxRetries) {
        const delayMs = computeBackoff(
          attempt,
          initialDelayMs,
          backoffFactor,
          maxDelayMs
        );
        console.error(
          `[brainstew] ${res.status} from ${typeof url === "string" ? url : url.toString()}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await sleep(delayMs);
        continue;
      }

      // All other responses (including successful ones) — return as-is
      return res;
    } catch (err) {
      // Network errors — retry with backoff
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delayMs = computeBackoff(
          attempt,
          initialDelayMs,
          backoffFactor,
          maxDelayMs
        );
        console.error(
          `[brainstew] Network error, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxRetries}): ${lastError.message}`
        );
        await sleep(delayMs);
        continue;
      }
    }
  }

  throw lastError ?? new Error("resilientFetch: all retries exhausted");
}

// --- Antigravity Endpoint Fallback ---

export async function antigravityFetchWithFallback(
  path: string,
  init: RequestInit,
  endpoints: readonly string[],
  options?: ResilientFetchOptions
): Promise<Response> {
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const res = await resilientFetch(`${endpoint}${path}`, init, options);

      // 403/404 from this endpoint — try next one
      if (res.status === 403 || res.status === 404) {
        console.error(
          `[brainstew] Antigravity endpoint ${endpoint} returned ${res.status}, trying next`
        );
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[brainstew] Antigravity endpoint ${endpoint} failed: ${lastError.message}`
      );
    }
  }

  throw (
    lastError ??
    new Error("All Antigravity endpoints failed — check your OAuth token")
  );
}
