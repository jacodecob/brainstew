# Advanced Provider Authentication — Subscription OAuth

Source: Multi-Model Council MCP Server architecture paper (2026-04-03), Gemini 3.1 Pro deep research. Implementation patterns derived from opencode (anomalyco/opencode).

## Overview

This document covers accessing frontier models via **personal subscription OAuth credentials** (ChatGPT Plus/Pro, Google Antigravity) rather than traditional enterprise API billing. This is a fundamentally different auth strategy than standard API keys — it routes queries through the providers' consumer product backends.

## xAI / Grok — API Key Baseline

xAI uses standard API key authentication. No complex OAuth required.

```
Authorization: Bearer <XAI_API_KEY>
Content-Type: application/json
```

- Standard `api.x.ai` endpoints
- Encapsulate in async task for concurrent dispatch alongside OAuth-backed providers
- This is already implemented in Brainstew

## Google Gemini — Antigravity Environment OAuth

Accessing Google's frontier models via personal subscription bypasses standard Vertex AI billing by authenticating against Google's **Antigravity** backend — the internal service powering Google's Cloud Code IDE extensions.

### Implementation (from opencode-antigravity-auth)

**Client Identification:**
- Use the specific OAuth Client ID for the Gemini CLI / Antigravity environment:
  `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com`
- This client ID signals to Google's identity provider that the request originates from an authorized IDE environment

**Scope Definition:**
Required scopes go beyond basic OpenID:
- `https://www.googleapis.com/auth/cloud-platform`
- `https://www.googleapis.com/auth/userinfo.email`
- Specialized experiment configuration scopes

**Local Callback Infrastructure:**
- Spin up localized HTTP listener on **port 51121**
- Redirect URI: `http://localhost:51121/oauth-callback`

**Endpoint Fallback Routing:**
Authenticated requests are NOT sent to standard public Generative AI endpoints. Instead, use the Antigravity endpoint fallback sequence:

1. **Daily Sandbox**: `https://daily-cloudcode-pa.sandbox.googleapis.com`
2. **Autopush**: `https://autopush-cloudcode-pa.sandbox.googleapis.com`
3. **Production**: (standard production endpoint)

### Known Edge Cases

- **macOS Safari HTTPS-Only Mode**: Blocks HTTP localhost callbacks, causing connection failures after successful Google auth
- **Docker / Remote SSH**: Cannot resolve localhost callbacks
- **Mitigation**: Provide explicit error logging and out-of-band fallback (manual auth code paste via supplementary tool call)

### Comparison with Brainstew's Current Google OAuth

| | Current (standard Desktop OAuth) | Antigravity OAuth |
|---|---|---|
| **Client ID** | User's own from Google Cloud Console | Gemini CLI fixed client ID |
| **Scopes** | `cloud-platform` | `cloud-platform` + `userinfo.email` + experiment scopes |
| **Callback port** | 1456 | 51121 |
| **API endpoint** | Standard Generative Language API | Antigravity sandbox/prod endpoints |
| **Billing** | API key billing or Cloud project | Personal subscription (free with Gemini) |
| **Setup** | Requires Google Cloud Console config | No user setup needed |

**Key advantage of Antigravity:** Zero setup for the user — no Google Cloud Console project, no API key, no billing account. Uses the same backend as `gemini-cli`.

## OpenAI Codex — ChatGPT Plus/Pro Subscription OAuth

Accessing OpenAI models via personal ChatGPT subscription uses the official Codex CLI OAuth flow, routing through the ChatGPT Codex backend rather than the standard API.

### Implementation (from opencode-openai-codex-auth)

**Authentication Trigger:**
- Use URL Elicitation (for remote) or direct browser open (for local) to prompt user to OpenAI authorization endpoint
- Identical to the flow used by the official Codex CLI

**Token Exchange:**
- Callback captures authorization code
- Exchanges for an OpenAI JSON Web Token (JWT)

**Header Generation:**
- Access token injected using highly specific headers tailored to the Codex environment
- Uses `OPENAI_HEADERS` constants and `JWT_CLAIM_PATH` extraction to mimic an official authorized client

**Model Variant Mapping:**
The Codex backend uses a **variant system** rather than standard API parameters:
- Reasoning effort maps to variants: `low`, `medium`, `high`, `xhigh`
- Applies to models in the GPT family

### Rate Limits

Personal subscription tokens have **aggressive rate limits** that differ significantly from programmatic API keys. The server must gracefully handle `429 Too Many Requests` responses indicating subscription capacity exhaustion.

### Key Distinction from Standard API

This is NOT the same as the Chat Completions API (`api.openai.com`):

| | Standard OpenAI API | Codex Subscription OAuth |
|---|---|---|
| **Auth** | API key (`sk-...`) | JWT from ChatGPT OAuth flow |
| **Endpoint** | `api.openai.com` | Codex backend endpoints |
| **Billing** | Pay-per-token API billing | ChatGPT Plus/Pro subscription |
| **Rate limits** | API tier-based | Subscription capacity-based |
| **Model access** | API-available models | Codex-available models |

**This means our prior research finding that "OpenAI API is API-key only" was narrowly correct about `api.openai.com` but missed that Codex backend access is possible via subscription OAuth.** The opencode project demonstrates this working pattern.

## Provider Summary

| Provider | Auth Method | Key Variables | Routing |
|----------|------------|---------------|---------|
| xAI (Grok) | API Key | `XAI_API_KEY` header | Standard `api.x.ai` |
| Google (Gemini) | Antigravity OAuth 2.0 | Emulated Client ID; Port 51121; Cloud-platform scopes | Fallback: Daily Sandbox -> Autopush -> Prod |
| OpenAI (Codex) | ChatGPT Plus/Pro OAuth | Codex CLI flow; JWT; Variant mapping | Codex backend endpoints |
