# OAuth 2.1 Requirements for MCP HTTP Transport

Source: Multi-Model Council MCP Server architecture paper (2026-04-03), Gemini 3.1 Pro deep research.

## When This Applies

The MCP specification **mandates** OAuth 2.1 (draft-ietf-oauth-v2-1-13) for all **remote HTTP-based transports**. Brainstew currently runs as a local stdio server, but this becomes critical if/when deployed remotely (e.g., on Vercel or a VPS).

## Dual-Layer Authentication

MCP defines strict trust boundaries between two distinct auth domains:

1. **Client ↔ MCP Server**: Claude Code authenticating with the Brainstew MCP server
2. **MCP Server ↔ Downstream APIs**: Brainstew authenticating with Google, OpenAI, xAI

**Critical rule:** The MCP server must **never** pass through the client's token to a downstream service. Doing so creates a "confused deputy" vulnerability. The server must independently acquire and manage downstream credentials.

## Required Standards

### OAuth 2.0 Protected Resource Metadata (RFC 9728)

The MCP server must expose discovery endpoints so clients can find the authorization server:

- Expose `/.well-known/oauth-protected-resource` endpoint, OR
- Return `WWW-Authenticate` header in 401 responses

This metadata advertises:
- `authorization_endpoint`
- `token_endpoint`
- `registration_endpoint`

### Resource Indicators (RFC 8707)

MCP clients must include the `resource` parameter in authorization and token requests, containing the canonical URI of the MCP server. This cryptographically binds issued tokens to that specific server, preventing token replay attacks across services.

### Dynamic Client Registration (RFC 7591)

Enables seamless client discovery without manual pre-configuration. If the identity provider doesn't support DCR, fall back to **Client ID Metadata Documents (CIMD)** — HTTPS URLs pointing to JSON metadata documents used as client identifiers.

### PKCE (Proof Key for Code Exchange) — Mandatory

OAuth 2.1 within MCP **requires** PKCE for all authorization code grants:

1. Client generates `code_verifier` (43-128 random characters)
2. Computes `code_challenge` = Base64URL(SHA256(code_verifier)) — **S256 method only**
3. Sends `code_challenge` in the authorization request
4. Sends original `code_verifier` during token exchange
5. Authorization server verifies the hash matches

This is already how Brainstew's Google OAuth works locally. For remote deployment, the same PKCE flow applies but the server also needs the RFC 9728/8707/7591 infrastructure.

## Summary Table

| Standard | Function | Required? |
|----------|----------|-----------|
| OAuth 2.1 (draft-ietf-oauth-v2-1-13) | Baseline framework | Mandatory for HTTP transport |
| RFC 9728 | Protected Resource Metadata (discovery) | Mandatory |
| RFC 8707 | Resource Indicators (token binding) | Mandatory |
| RFC 7591 | Dynamic Client Registration | Recommended (CIMD fallback) |
| PKCE (S256) | Code interception mitigation | Mandatory |

## Implications for Brainstew

### Current state (stdio)
- Not applicable — stdio transport doesn't use HTTP OAuth
- Our local PKCE flow with Google is already spec-aligned

### Future remote deployment (Vercel)
- Must implement RFC 9728 discovery endpoints
- Must implement RFC 8707 resource indicators
- Must support RFC 7591 DCR or CIMD fallback
- Must serve as its own OAuth authorization server for client auth
- Vercel hobby plan limitation: serverless function timeout (10s default, 60s max on Pro) may be tight for the full council deliberation pipeline
