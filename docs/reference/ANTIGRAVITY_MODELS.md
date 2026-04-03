# Antigravity Model Availability (Updated 2026-04-03)

## Available Gemini Models on Antigravity Endpoints

Antigravity uses **internal model names** that may differ from public-facing API names. A model alias mapping layer translates between them.

### Current Models (as of April 2026)

| Public Name | Internal Name | Status |
|---|---|---|
| `gemini-3.1-pro` | `gemini-3.1-pro-high` / `gemini-3.1-pro-low` | **Active** (recommended) |
| `gemini-3-flash` | `gemini-3-flash` | Active |
| `gemini-3-pro-preview` | `gemini-3-pro-high` | **Deprecated** (shut down March 9, 2026) |
| `gemini-2.5-flash-preview` | `gemini-2.5-flash` | Legacy |

### Non-Gemini Models (via Antigravity)

Antigravity also proxies Claude models:
- `claude-sonnet-4-6` (via `gemini-claude-sonnet-4-6` alias)
- `claude-opus-4-6` (via `gemini-claude-opus-4-6` alias)

### Deprecated / Non-Existent

- `gemini-2.5-pro` — **Does not exist** as an Antigravity model. Was incorrectly used in prior Brainstew versions.
- `gemini-3-pro` / `gemini-3-pro-preview` — Shut down March 9, 2026. Must use `gemini-3.1-pro`.

## Endpoints

Antigravity Cloud Code endpoints (in fallback order):
1. `https://daily-cloudcode-pa.sandbox.googleapis.com` (Daily sandbox)
2. `https://autopush-cloudcode-pa.sandbox.googleapis.com` (Autopush)
3. `https://cloudcode-pa.googleapis.com` (Production)

## Sources

- [DeepWiki: Gemini (CLI & Antigravity)](https://deepwiki.com/justlovemaki/AIClient-2-API/3.1-gemini-(cli-and-antigravity)) — Model alias mapping and endpoint structure
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) — Original OpenCode integration (archived March 30, 2026)
- [antigravity-claude-proxy models.md](https://github.com/badrisnarayanan/antigravity-claude-proxy/blob/main/docs/models.md) — Available model list
- [Google Blog: Gemini 3.1 Pro](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/) — Official availability announcement
- [Google Blog: Gemini 3](https://blog.google/products/gemini/gemini-3/) — Antigravity launch alongside Gemini 3
