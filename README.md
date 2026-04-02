# Brainstew

Multi-model deliberation MCP server. Fans out prompts to GPT, Gemini, and Grok in parallel, returns structured responses for Claude (or any MCP host) to synthesize.

## Quick Start

```bash
git clone https://github.com/jacodecob/brainstew.git
cd brainstew
npm install
npm run build
```

### Add to Claude Code

```bash
claude mcp add brainstew node /path/to/brainstew/dist/index.js
```

Or add to your project's `.mcp.json`:

```json
{
  "brainstew": {
    "command": "node",
    "args": ["/path/to/brainstew/dist/index.js"],
    "env": {
      "OPENAI_API_KEY": "${OPENAI_API_KEY}",
      "GEMINI_API_KEY": "${GEMINI_API_KEY}",
      "XAI_API_KEY": "${XAI_API_KEY}"
    }
  }
}
```

### Add to other MCP hosts

Brainstew uses stdio transport. Any MCP-compatible host (Codex, OpenCode, etc.) can launch it the same way — run `node dist/index.js` and communicate over stdin/stdout.

## Authentication

Brainstew uses **OAuth first, API keys as fallback**.

### Option A: OAuth (recommended)

Once the server is running, ask your agent to call the `brainstew_login` tool:

```
Use brainstew_login to authenticate with openai
```

This opens a browser-based PKCE OAuth flow. Tokens are stored securely in your OS keychain (macOS Keychain, libsecret, or Windows Credential Vault) and auto-refresh on expiry.

OAuth is supported for **OpenAI** and **Google**. xAI/Grok requires an API key (no OAuth available).

### Option B: API keys (fallback)

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

```
OPENAI_API_KEY=sk-...    # https://platform.openai.com/api-keys
GEMINI_API_KEY=...        # https://aistudio.google.com/apikey
XAI_API_KEY=xai-...      # https://console.x.ai
```

API keys are checked **only if no valid OAuth token exists** for that provider.

### Credential priority

1. Stored OAuth tokens (OS keychain)
2. Stored API keys
3. Environment variable API keys

## Tools

### `brainstew_council`

Fan out a prompt to multiple models in parallel. Returns each model's response with latency and auth method.

```
prompt: "What's the best approach for caching in a distributed system?"
models: ["gpt", "gemini", "grok"]   # optional, defaults to all three
context: "We use Redis and PostgreSQL"  # optional
```

Returns both a text summary and typed `structuredContent` with per-model response objects. Emits progress notifications as each model completes.

### `brainstew_login`

Authenticate with a provider via OAuth.

```
provider: "openai" | "google"
```

Opens a browser for consent, catches the redirect locally, stores tokens in the OS keychain.

### `brainstew_auth_status`

Check credential status for all providers. Shows whether each is using OAuth, API key, or unconfigured.

## Development

```bash
npm run dev    # run with tsx (hot reload)
npm run build  # compile TypeScript
npm start      # run compiled output
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector --cli --transport stdio -- node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli --transport stdio -- node dist/index.js --method tools/call --tool-name brainstew_auth_status
```

## Architecture

- `src/index.ts` — MCP server, tool registration, formatting
- `src/auth.ts` — OAuth PKCE flow, keychain storage, token refresh
- `src/providers.ts` — Model-specific API calls (OpenAI, Google, xAI)
- `docs/reference/` — Design decisions and auth strategy docs

Built with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`).

## License

MIT
