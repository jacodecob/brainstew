# URL Mode Elicitation (SEP-1036)

Source: Multi-Model Council MCP Server architecture paper (2026-04-03), Gemini 3.1 Pro deep research. Introduced in MCP spec 2025-11-25.

## Problem

When the MCP server needs the user's OAuth tokens for downstream providers (Google, OpenAI), how do you acquire those credentials securely?

- **Environment variables**: Insecure for remote servers (plaintext secrets, exfiltration risk)
- **Form elicitation**: MCP spec **prohibits** using form elicitation for passwords, API keys, access tokens, or payment credentials — routing tokens through the client collapses the trust boundary

## Solution: Out-of-Band URL Elicitation

URL Elicitation provides a secure mechanism for the MCP server to obtain third-party authorization **without credentials ever transiting through the MCP client** (Claude Code).

## Flow

### 1. Interruption
When `council_query` is invoked and the server detects missing downstream credentials (e.g., no active Google token), tool execution pauses.

### 2. Error Signal
Server raises a `UrlElicitationRequiredError` mapped to **JSON-RPC error code `-32042`**.

### 3. Payload Construction
The error payload contains an `ElicitRequestURLParams` object:
- `url`: Secure authorization URL (the OAuth consent screen for the downstream provider)
- `elicitationId`: Unique identifier to correlate the callback

### 4. Client Rendering
The MCP client (Claude Code) intercepts the -32042 error:
- Presents the target domain to the user
- Requests explicit consent to open the external browser

### 5. External Authentication
User completes auth directly with the third-party authorization server (Google, OpenAI) in a secure, isolated browser context.

### 6. Callback and Exchange
The provider redirects back to a callback endpoint hosted by the MCP server. The server exchanges the authorization code for downstream access and refresh tokens.

### 7. Resumption
Once credentials are bound, the client receives an `elicitation/complete` notification and automatically retries the original tool request.

## State Management (CSRF Protection)

The server must verify that the user completing the browser auth is the same user who initiated the request:

1. Generate cryptographically secure random `state` value
2. Store it server-side linked to the user's MCP session
3. Append it to the authorization URL
4. On callback, validate the returned `state` against the stored mapping
5. Only then exchange the code for tokens

This neutralizes CSRF and session hijacking.

## Comparison with Brainstew's Current Approach

| | Current (stdio) | URL Elicitation (remote HTTP) |
|---|---|---|
| **Transport** | stdio (local process) | HTTP (remote server) |
| **Auth trigger** | `brainstew_login` tool call | Automatic on missing credentials |
| **Browser flow** | Server opens browser directly | Client mediates via -32042 error |
| **Credential transit** | Never leaves local machine | Never transits through MCP client |
| **Session binding** | Implicit (single local user) | Explicit via `state` parameter |

## When to Implement

- **Now (stdio)**: Not needed. The current `brainstew_login` tool with direct browser open is the correct pattern for local stdio servers.
- **Future (remote HTTP)**: Required. When Brainstew is deployed remotely, URL Elicitation becomes the secure way to handle downstream OAuth without collapsing trust boundaries.

## Limitations of Form Elicitation (for reference)

The MCP spec strictly prohibits form elicitation for:
- Passwords
- API keys
- Access tokens
- Payment credentials

Form elicitation is fine for non-sensitive structured input (e.g., selecting evaluation criteria for the council).
