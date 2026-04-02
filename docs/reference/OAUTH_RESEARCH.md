# OAuth Research Findings

Research conducted 2026-04-02 by auditing opencode (anomalyco/opencode), pi-mono (badlogic/pi-mono), and official provider docs.

## Provider OAuth Support for API Access

| Provider | OAuth for API? | Details |
|----------|---------------|---------|
| **OpenAI** | **No** | Chat Completions API is API-key only. `auth.openai.com` is for ChatGPT Actions/Apps SDK, NOT for API access tokens. Codex CLI uses API keys. |
| **Google (Gemini)** | **Yes** | Generative Language API supports OAuth bearer tokens. Use Desktop app client type. Scope: `cloud-platform`. The scope `generative-language` does NOT exist. |
| **xAI (Grok)** | **No** | API-key only. xAI offers OAuth for data source integrations in "Grok for Business" but NOT for API auth. |

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

## OpenAI "OAuth" Clarification

The "OAuth" support listed in opencode and pi-mono for OpenAI is for:
- Authenticating with **ChatGPT subscriptions** (consumer product)
- Using **OpenAI Apps SDK** for ChatGPT integrations
- **NOT** for programmatic API access via Chat Completions

The OpenAI API (`api.openai.com`) only accepts: `Authorization: Bearer sk-...` (API keys).

## Sources

- [OpenCode Auth Docs](https://opencode.ai/docs/cli/auth)
- [pi-mono OAuth Implementation](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/oauth/index.ts)
- [Google Gemini OAuth Quickstart](https://ai.google.dev/gemini-api/docs/oauth)
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [OpenAI API Authentication](https://platform.openai.com/docs/api-reference/authentication)
- [Claude Code OAuth Issues](https://github.com/anthropics/claude-code/issues?q=oauth)
