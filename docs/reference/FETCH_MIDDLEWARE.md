# Resilient Fetch Middleware Patterns

Source: Multi-Model Council MCP Server architecture paper (2026-04-03), Gemini 3.1 Pro deep research. Patterns derived from opencode (anomalyco/opencode).

## Problem

Personal OAuth tokens are inherently fragile:
- Tokens expire silently
- Rate limits are aggressively enforced during parallel dispatch
- Sessions drop unexpectedly
- Consumer subscription tiers have tighter capacity than API keys

The fetch middleware must create a **self-healing communication layer** that handles these failures transparently.

## Pattern 1: Automated Token Refresh

When a downstream provider returns `401 Unauthorized` or `403 Forbidden`:

1. **Intercept** the HTTP status code in the fetch middleware (before it propagates up)
2. **Refresh** using the stored refresh token to silently request a new access token
3. **Update** internal credential state and rewrite request headers
4. **Retry** the original request automatically
5. **Return** the successful response as if no failure occurred

The failure is **invisible to the end user and host agent**. The council deliberation continues uninterrupted.

```
Request → 401 → Refresh token → New access token → Retry → Success
                     ↓ (if refresh fails)
              Fall through to API key or error
```

### Implementation Notes

- Refresh should be **synchronous within the request context** — don't return the error and retry later
- Track refresh attempts to avoid infinite loops (max 1-2 refresh retries per request)
- If refresh fails (revoked token, expired refresh token), fall through to the next credential in the resolution order (API key fallback)
- Log refresh events for debugging but don't surface them as errors

## Pattern 2: Rate Limit Mitigation & Multi-Account Failover

During the Divergence stage, simultaneous complex prompts easily trigger rate limits on consumer tiers.

**Credential Rotation (from opencode):**

1. Allow users to register **multiple accounts** per provider (e.g., two Google Antigravity logins)
2. When middleware encounters `429 Too Many Requests` with a `Retry-After` header:
   - Assess the required cooldown period
   - Instead of waiting, **pivot to the next available credential** in that provider's pool
3. If all credentials exhausted, then respect `Retry-After` or degrade gracefully

```
Request → 429 → Check credential pool → Rotate to next account → Retry → Success
                                              ↓ (if pool exhausted)
                                     Wait for Retry-After or degrade
```

### For Brainstew

Currently Brainstew supports single credentials per provider. Multi-account rotation is a future enhancement. The immediate value is:
- Handling `429` gracefully (wait and retry, or exclude the model from the current council)
- Not crashing the entire council pipeline when one provider is rate-limited

## Pattern 3: Secure Credential Persistence (OS Keyring)

**Already implemented in Brainstew** via `@napi-rs/keyring`.

The pattern from the research confirms our approach:

1. Serialize the full token payload (`access_token`, `refresh_token`, `expiry` metadata)
2. Store via OS keyring using a composite identifier:
   - Service: `mcp_council_aggregator` (or `brainstew`)
   - Username: provider identifier (e.g., `google_antigravity`)
3. Read dynamically during tool calls
4. Fall back to encrypted file storage if keyring unavailable

**Brainstew's implementation:**
- Uses `@napi-rs/keyring` → macOS Keychain / libsecret / Windows Credential Vault
- Falls back to `~/.brainstew/auth.json` with `0o600` permissions
- Automatic migration from file to keyring on first access

## Pattern 4: Graceful Degradation (Partial Council)

Individual model failures should **not crash the entire pipeline**.

1. Wrap each model's request in isolated error handling
2. If a model fails (timeout, auth failure, rate limit), **exclude it** from the subsequent stages
3. Dynamically resize the peer review matrix based on successful participants
4. A council of 2 models still provides peer review value over a single model

```
Divergence:  GPT ✓  |  Gemini ✓  |  Grok ✗ (timeout)
                ↓           ↓
Convergence: GPT reviews Gemini, Gemini reviews GPT (2x2 matrix instead of 3x3)
                ↓
Synthesis:   Chairman synthesizes from 2 responses + 2 reviews
```

**Already partially in Brainstew:** `Promise.allSettled` handles individual failures. The current response includes which models succeeded/failed. Extending this to multi-stage would follow the same pattern.

## Pattern 5: Progress Notifications During Recovery

When the middleware is performing recovery (refresh, rotation), emit progress notifications so the host client doesn't assume a timeout:

- "Refreshing credentials for Google Gemini..."
- "Rate limited by OpenAI, rotating credentials..."
- "Grok timed out, proceeding with 2/3 models"

Brainstew already emits per-model progress — extend this to cover recovery events.
