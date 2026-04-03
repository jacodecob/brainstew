# Brainstew — Project Goals & Design Principles

## What Brainstew Is

A **multi-model deliberation MCP server** that fans out prompts to GPT (OpenAI), Gemini (Google), and Grok (xAI) in parallel, returning structured responses for the host agent (Claude) to synthesize into a single, better answer.

## Primary Consumers

Brainstew is designed to be consumed by **AI agent tools**, not browser-based UIs:

- **Claude Code** (Anthropic)
- **Codex** (OpenAI)
- **OpenCode**
- Other MCP-compatible agent hosts

These tools invoke Brainstew's tools programmatically via the MCP protocol over stdio transport.

## Core Design Principles

### 1. OAuth-First Authentication

**OAuth is the primary authentication method. API keys are a secondary fallback.**

This is a deliberate, non-negotiable design decision. The credential resolution order is:

1. **Stored OAuth tokens** (preferred — secure, auto-refreshable, scoped)
2. **Stored API keys** (secondary — from ~/.brainstew/auth.json)
3. **Environment variable API keys** (last resort — fallback for quick setup)

**Why OAuth first:**
- OAuth tokens are scoped and revocable — safer for production use
- Auto-refresh means no manual key rotation
- Agent tools (Claude Code, etc.) are increasingly shipping OAuth support
- API keys are static secrets that can leak and grant broad access

**Do NOT change this priority order.** If you're adding a new provider, follow this same hierarchy.

### 2. Agent-Native, Not Browser-Native

Brainstew runs as a **local stdio MCP server** launched by agent tools. It is not a web service. OAuth flows open a browser for the initial login redirect, but all subsequent token management (refresh, storage, resolution) happens locally and automatically.

### 3. Spec-Compliant MCP

Follow the MCP specification and official Anthropic guidance:
- Use `registerTool()` (not the deprecated `server.tool()`)
- Include `instructions` on the server for system-prompt hints
- Use tool annotations (`readOnlyHint`, `openWorldHint`, etc.)
- Return `isError: true` with recovery hints on failures
- Keep tool descriptions precise and disambiguating

### 4. Graceful Degradation

If OAuth fails or isn't configured for a provider, fall through to API keys silently. If neither is available, return a clear error with instructions on how to authenticate. Never crash the server over a single provider's auth failure.

## Provider Support Matrix

| Provider | Standard API OAuth | Subscription OAuth | API Key | Notes |
|----------|-------------------|-------------------|---------|-------|
| OpenAI (GPT/Codex) | **No** | **Yes** (Codex backend) | Yes | Chat Completions API is API-key only. Codex backend accessible via ChatGPT Plus/Pro subscription OAuth. |
| Google (Gemini) | Yes (PKCE) | **Yes** (Antigravity) | Yes | Standard OAuth requires Cloud Console client ID. Antigravity OAuth uses emulated Gemini CLI client ID (zero setup). |
| xAI (Grok) | **No** | **No** | Yes | API-key only. |

**Note:** Both Google and OpenAI support subscription-based OAuth that routes through consumer product backends, bypassing API billing. See `PROVIDER_AUTH_ADVANCED.md` for implementation details. The OAuth-first credential resolution applies to all OAuth methods — subscription or standard.

## Implemented Features (v0.6.0)

- **Structured output**: `outputSchema` defined via Zod on `brainstew_council`, `structuredContent` returned alongside the text fallback. Hosts that support typed output get a clean `{ modelsQueried, responses[] }` object.
- **Progress notifications**: Emitted per-model as each completes during parallel council queries. Host must send a `progressToken` in `_meta` to receive them.
- **OS keychain storage**: Credentials stored via `@napi-rs/keyring` (macOS Keychain / libsecret / Windows Credential Vault). Automatic file-based fallback and migration from legacy `~/.brainstew/auth.json`.
- **Auto browser open**: `brainstew_login` attempts to launch the system browser automatically (`open` / `xdg-open` / `start`), with URL logged to stderr as fallback.
- **Google refresh tokens**: `access_type=offline` + `prompt=consent` ensures Google always issues a refresh token.
- **Google Antigravity OAuth** (v0.6.0): Zero-setup Google OAuth emulating Gemini CLI. Uses hardcoded Antigravity client ID — no Cloud Console project needed. Queries frontier models via Antigravity sandbox/production endpoints.
- **OpenAI Codex subscription OAuth** (v0.6.0): Authenticate via ChatGPT Plus/Pro subscription. Routes queries through the Codex backend at `chatgpt.com`. JWT-based auth with account ID extraction.
- **Resilient fetch middleware** (v0.6.0): Automatic retry on 429 (with Retry-After/exponential backoff), 5xx retry, token refresh on 401/403, and Antigravity endpoint fallback.
- **Proactive token refresh** (v0.6.0): Tokens refreshed 5 minutes before expiry (up from 60 seconds).

## MCP Spec Compliance

Audited against the official Anthropic `mcp-server-dev` plugin (installed at `~/.claude/plugins`). All actionable recommendations implemented:

- `registerTool()` (not deprecated `server.tool()`)
- Server `instructions` field (lands in host system prompt)
- Tool annotations: `readOnlyHint`, `openWorldHint`
- `outputSchema` + `structuredContent` with text fallback
- `isError: true` on failures with recovery hints
- Parameter `.describe()` on every input field
- Tool descriptions cross-reference siblings

## Testing

Tested via MCP Inspector CLI (`npx @modelcontextprotocol/inspector --cli`):
- `tools/list` — all 3 tools with full schemas and annotations
- `brainstew_auth_status` — works with and without credentials
- `brainstew_council` — all 3 models individually and in parallel
- Error paths — no-credential errors return clean recovery hints
- Keychain — write/read/delete/migration all verified
- `initialize` — `instructions` field present in server response

## Future Considerations

- **Remote HTTP deployment**: Currently local stdio only. If Brainstew is ever deployed remotely, implement OAuth 2.1 per MCP spec 2025-11-25 (see `OAUTH_21_MCP_SPEC.md` and `URL_ELICITATION.md`).
- **Additional models**: When adding providers, always implement OAuth first if available.
- **Multi-stage council**: Implement Stage 2 (Convergence/peer review) and Stage 3 (Synthesis) server-side (see `COUNCIL_ARCHITECTURE.md`).
- **Credential rotation**: Multi-account failover per provider on rate limits (see `FETCH_MIDDLEWARE.md`).
- **Device code flow**: Headless Codex auth via `auth.openai.com/api/accounts/deviceauth/usercode`.
- **Elicitation**: Could use spec-native elicitation for confirming destructive actions if any are added (requires Claude Code >= 2.1.76).
- **Sampling**: If tool logic ever needs LLM inference internally, use MCP sampling instead of shipping a separate model client.
