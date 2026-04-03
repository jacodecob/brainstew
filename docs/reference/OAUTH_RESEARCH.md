# OAuth Research Findings

Research conducted 2026-04-02, updated 2026-04-03 with Gemini 3.1 Pro deep research findings.

Audited: opencode (anomalyco/opencode), pi-mono (badlogic/pi-mono), official provider docs, and "Architecting a Multi-Model Council MCP Server" (Gemini deep research).

## Provider OAuth Support — Two Tiers

There are **two distinct tiers** of OAuth access for LLM providers:

1. **Standard API OAuth**: Using provider's public API endpoints with OAuth tokens (e.g., Google Generative Language API)
2. **Subscription OAuth**: Using personal subscription credentials (ChatGPT Plus/Pro, Google Antigravity) to access models via consumer product backends — bypassing API billing entirely

| Provider | Standard API OAuth | Subscription OAuth | API Key |
|----------|-------------------|-------------------|---------|
| **OpenAI** | No (Chat Completions is API-key only) | **Yes** — Codex backend via ChatGPT Plus/Pro OAuth (opencode pattern) | `sk-...` |
| **Google (Gemini)** | Yes (Desktop app, `cloud-platform` scope) | **Yes** — Antigravity environment OAuth (emulated IDE client) | `GEMINI_API_KEY` |
| **xAI (Grok)** | No | No | `XAI_API_KEY` |

### Correction from prior research
Our 2026-04-02 finding that "OpenAI API is API-key only" was narrowly correct about `api.openai.com/v1/chat/completions` but **missed that Codex backend access is possible via subscription OAuth**. The opencode project (opencode-openai-codex-auth) demonstrates the ChatGPT Plus/Pro OAuth flow — this routes through the Codex backend, not the standard Chat Completions API. See `PROVIDER_AUTH_ADVANCED.md` for full details.

## Key Lessons from opencode and pi-mono

### 1. Auth URL must be in the tool response, not stderr

In MCP context, `console.error()` (stderr) is invisible to the agent and user. Both opencode and pi-mono solve this by returning the auth URL through the visible channel (tool response or UI).

**opencode fix (PR #7884):** Previously showed "Something went wrong" with no URL. Now displays the authorization URL as fallback when browser open fails.

**pi-mono pattern:** Uses `OAuthLoginCallbacks` interface with multiple strategies:
- `onAuth()` — opens browser
- `onDeviceCode()` — displays user code for headless environments
- `onManualCodeInput()` — fallback for pasting auth codes
- `onPrompt()` — direct token entry

### 2. Don't block the tool call waiting for callback

The old pattern (start callback server, block for 2 minutes) is wrong for MCP. Split into two phases:
- **Phase 1:** Start callback server, return URL immediately
- **Phase 2:** Separate tool call to await the callback

### 3. Browser open is best-effort only

`exec("open ...")` fails silently in: SSH sessions, devcontainers, WSL, headless environments, and some MCP contexts. Always treat it as optional — the URL in the tool response is the primary mechanism.

## Known Claude Code OAuth Issues

From GitHub issues on anthropics/claude-code:
- **HTTPS redirect URI mismatch:** Some providers require HTTPS, but Claude Code uses `http://localhost`
- **RFC 8252 violation:** Claude Code uses `localhost` hostname instead of `127.0.0.1` loopback IP
- **Devcontainer port forwarding:** localhost port isn't forwarded to host in containers
- **Callback server hangs:** Several reports of `/login` command hanging after authorization

## Google OAuth Setup for Brainstew

To enable Google Gemini OAuth:

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID
3. Application type: **Desktop app**
4. Set `GOOGLE_OAUTH_CLIENT_ID` env var to the client ID
5. Enable the Generative Language API in the project
6. Redirect URI: `http://127.0.0.1:1456/callback` (auto-allowed for Desktop apps)

## OpenAI OAuth — Updated Understanding

There are **two separate OpenAI OAuth contexts**:

1. **ChatGPT Actions / Apps SDK OAuth** (`auth.openai.com`): For building ChatGPT plugins and integrations. NOT for API access.
2. **Codex CLI Subscription OAuth**: The official Codex CLI uses an OAuth flow to authenticate against the ChatGPT Plus/Pro subscription. This grants access to the **Codex backend** — a separate system from the standard Chat Completions API.

The standard API (`api.openai.com`) still only accepts API keys (`sk-...`). But the Codex backend — accessible via subscription OAuth — provides model access billed against the user's ChatGPT subscription rather than API credits.

**Implementation details**: JWT-based auth, specific `OPENAI_HEADERS`, variant mapping for reasoning effort levels. See `PROVIDER_AUTH_ADVANCED.md`.

## Sources

- [OpenCode Auth Docs](https://opencode.ai/docs/cli/auth)
- [pi-mono OAuth Implementation](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/oauth/index.ts)
- [Google Gemini OAuth Quickstart](https://ai.google.dev/gemini-api/docs/oauth)
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [OpenAI API Authentication](https://platform.openai.com/docs/api-reference/authentication)
- [Claude Code OAuth Issues](https://github.com/anthropics/claude-code/issues?q=oauth)
