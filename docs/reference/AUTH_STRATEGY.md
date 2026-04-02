# Brainstew — Authentication Strategy

## Overview

Brainstew authenticates with upstream AI providers (OpenAI, Google, xAI) to make API calls on behalf of the user. Authentication is designed for **agent tool consumers** (Claude Code, Codex, OpenCode) — not browser-based applications.

## Credential Resolution Order

```
getAccessToken(providerId, config, envApiKey?)
│
├─ 1. Check stored OAuth token (highest priority)
│     ├─ Valid and not expired → USE IT
│     ├─ Expired + has refresh token → Refresh, store, USE IT
│     └─ Expired + refresh failed → fall through
│
├─ 2. Check stored API key (~/.brainstew/auth.json)
│     └─ Present → USE IT
│
├─ 3. Check environment variable API key
│     └─ Present → USE IT
│
└─ 4. Throw error with recovery instructions
      → "Use brainstew_login tool or set env var"
```

**This order is intentional.** OAuth tokens take absolute priority over API keys because they are:
- Scoped (limited permissions)
- Revocable (can be invalidated remotely)
- Auto-refreshable (no manual rotation)
- Time-limited (reduced blast radius if leaked)

## OAuth Implementation Details

### Flow: Authorization Code + PKCE

All OAuth providers use the **Authorization Code flow with PKCE** (Proof Key for Code Exchange):

1. Server generates a `code_verifier` (random 32 bytes, base64url)
2. Derives `code_challenge` = SHA256(code_verifier), base64url-encoded
3. Constructs authorization URL with `code_challenge` + `code_challenge_method=S256`
4. Opens browser for user consent
5. Catches redirect on localhost callback port
6. Exchanges authorization code + `code_verifier` for tokens
7. Stores tokens in OS keychain (falls back to `~/.brainstew/auth.json`)

### Security Measures

- **PKCE**: Prevents authorization code interception attacks
- **State parameter**: Prevents CSRF attacks (verified on callback)
- **Localhost-only callback**: `127.0.0.1` binding, not `0.0.0.0`
- **2-minute timeout**: Callback server auto-closes if no response
- **OS keychain storage**: Credentials stored in macOS Keychain / libsecret / Windows Credential Vault (file fallback with `0o600` permissions)
- **Auto-refresh**: Tokens refreshed 60 seconds before expiry
- **Google offline access**: `access_type=offline` + `prompt=consent` ensures refresh tokens are always issued

### Provider-Specific Configs

| Provider | OAuth | API Key | Notes |
|----------|-------|---------|-------|
| OpenAI (GPT) | **Not supported** | `OPENAI_API_KEY` | OpenAI Chat Completions API is API-key only. No public OAuth. |
| Google (Gemini) | Yes (PKCE, port 1456) | `GEMINI_API_KEY` | Requires `GOOGLE_OAUTH_CLIENT_ID` from Google Cloud Console |
| xAI (Grok) | **Not supported** | `XAI_API_KEY` | xAI does not offer OAuth |

**Important:** OpenAI's `auth.openai.com` endpoints are for ChatGPT Actions/MCP servers authenticating users against *your* auth server — they do NOT issue API access tokens for Chat Completions.

## OAuth for Agent Tools (Claude Code, Codex, etc.)

Agent tools consume Brainstew via MCP stdio transport. The OAuth flow is triggered by the `brainstew_login` tool, which:

1. The agent calls `brainstew_login` with a provider name
2. Brainstew logs the authorization URL to stderr (visible to the agent host)
3. The user opens the URL in their browser and consents
4. The localhost callback catches the redirect
5. Tokens are exchanged and stored
6. Subsequent `brainstew_council` calls use the OAuth token automatically

**Important**: The agent tool itself does NOT need to implement OAuth. Brainstew handles the entire flow. The agent just needs to:
- Call `brainstew_login` when it sees an auth error
- Call `brainstew_auth_status` to check credential state

## API Key Fallback

API keys are supported as a fallback for:
- Quick setup / prototyping (set env vars, skip OAuth)
- Providers that don't support OAuth (xAI/Grok)
- CI/CD or headless environments where browser OAuth isn't possible

Set via environment variables:
```
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
XAI_API_KEY=xai-...
```

## Keychain Storage (Implemented)

Per official MCP guidance, credentials are stored in the **OS keychain** via `@napi-rs/keyring`:

- **macOS**: macOS Keychain
- **Linux**: libsecret (GNOME Keyring / KDE Wallet)
- **Windows**: Windows Credential Vault

**Fallback**: If the keychain is unavailable (headless environments, missing libsecret), falls back to `~/.brainstew/auth.json` with mode `0o600`.

**Migration**: On first keychain access, existing file-based credentials are automatically migrated to the keychain.

The `loadAuthStore`/`saveAuthStore` interface is unchanged — the storage backend is transparent to callers.
