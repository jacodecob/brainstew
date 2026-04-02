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
claude mcp add brainstew \
  -e OPENAI_API_KEY=sk-your-key \
  -e GEMINI_API_KEY=your-key \
  -e XAI_API_KEY=xai-your-key \
  -- node /path/to/brainstew/dist/index.js
```

Or add to your project's `.mcp.json`:

```json
{
  "brainstew": {
    "command": "node",
    "args": ["/path/to/brainstew/dist/index.js"],
    "env": {
      "OPENAI_API_KEY": "sk-your-key",
      "GEMINI_API_KEY": "your-key",
      "XAI_API_KEY": "xai-your-key"
    }
  }
}
```

### Add to other MCP hosts

Brainstew uses stdio transport. Any MCP-compatible host (Codex, OpenCode, etc.) can launch it the same way — run `node dist/index.js` and communicate over stdin/stdout. Pass API keys as environment variables.

## Authentication

### API keys (primary method)

Most providers require API keys. Get yours and pass them as env vars:

| Provider | Env Var | Get a key |
|----------|---------|-----------|
| OpenAI (GPT-4o) | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| Google (Gemini) | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| xAI (Grok) | `XAI_API_KEY` | https://console.x.ai |

You can set env vars in the MCP config (see above), in a `.env` file (`cp .env.example .env`), or in your shell.

### Guided setup

On first use, the agent will call `brainstew_setup` to check which providers are configured and guide the user through setup. You can also ask:

```
Run brainstew_setup to check my configuration
```

### OAuth (Google only, optional)

Google Gemini optionally supports OAuth via PKCE. This requires a Google Cloud OAuth client ID:

1. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Set `GOOGLE_OAUTH_CLIENT_ID` env var
3. Ask the agent to call `brainstew_login` with provider `google`

OpenAI and xAI do **not** support OAuth for API access — API keys only.

### Credential priority

1. Stored OAuth tokens (OS keychain — Google only)
2. Stored API keys
3. Environment variable API keys

## Tools

### `brainstew_setup`

Guided first-run configuration. Shows which providers are ready and which need API keys, with direct links.

### `brainstew_council`

Fan out a prompt to multiple models in parallel. Returns each model's response with latency and auth method.

```
prompt: "What's the best approach for caching in a distributed system?"
models: ["gpt", "gemini", "grok"]   # optional, defaults to all three
context: "We use Redis and PostgreSQL"  # optional
```

Returns both a text summary and typed `structuredContent` with per-model response objects. Emits progress notifications as each model completes.

### `brainstew_login`

Authenticate with Google via OAuth (the only provider that supports it). Do not use for OpenAI or xAI.

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
npx @modelcontextprotocol/inspector --cli --transport stdio -- node dist/index.js --method tools/call --tool-name brainstew_setup
npx @modelcontextprotocol/inspector --cli --transport stdio -- node dist/index.js --method tools/call --tool-name brainstew_auth_status
```

## Architecture

- `src/index.ts` — MCP server, tool registration, formatting
- `src/auth.ts` — OAuth PKCE flow, keychain storage, token refresh, credential resolution
- `src/providers.ts` — Model-specific API calls (OpenAI, Google, xAI)
- `docs/reference/` — Design decisions and auth strategy docs

Built with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`).

## License

MIT
