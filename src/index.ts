import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryAllModels, type ModelResponse } from "./providers.js";
import {
  startOAuthLogin,
  awaitOAuthCallback,
  completeOAuthManually,
  getActivePendingFlow,
  loadAuthStore,
} from "./auth.js";
import {
  PROVIDER_OAUTH_CONFIGS,
  PROVIDER_AUTH_SUPPORT,
  LOGIN_PROVIDER_MAP,
} from "./oauth-configs.js";

loadProjectEnv();

function loadProjectEnv(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectEnvPath = join(dirname(moduleDir), ".env");

  try {
    const raw = readFileSync(projectEnvPath, "utf-8");

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return;
    }

    console.error(
      `[brainstew] Failed to load project .env: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const server = new McpServer(
  {
    name: "brainstew",
    version: "0.6.0",
  },
  {
    instructions:
      "Brainstew fans out prompts to GPT, Gemini, and Grok in parallel. " +
      "Call brainstew_setup first to check which providers are ready. If providers show as configured (via API key or OAuth), they are ready — do NOT push the user to set up OAuth unprompted. " +
      "brainstew_council is the main tool — send it a prompt and optional model list. " +
      "IMPORTANT: If brainstew_council returns auth errors for a provider, the stored token may be revoked upstream even if brainstew_auth_status shows it as active. In that case, suggest re-authenticating with brainstew_login for the failing provider. Re-authenticate ONE provider at a time — only one login flow can be active at a time, never call brainstew_login in parallel. " +
      "brainstew_auth_status shows locally-cached credential state (tokens may be revoked upstream without local expiry changing).",
  }
);

// --- Council tool ---

server.registerTool(
  "brainstew_council",
  {
    description:
      "Fan out a prompt to multiple AI models (GPT, Gemini, Grok) in parallel and return their diverse perspectives. Use this for complex questions, architectural decisions, or any situation where multiple viewpoints improve synthesis. Does NOT store or modify data — read-only queries to external model APIs. If a model returns an auth error, call brainstew_setup for configuration guidance.",
    inputSchema: {
      prompt: z
        .string()
        .describe(
          "The question or problem to send to all models. Frame it clearly — each model receives this verbatim."
        ),
      models: z
        .array(z.enum(["gpt", "gemini", "grok"]))
        .default(["gpt", "gemini", "grok"])
        .describe("Which models to query. Defaults to all three."),
      context: z
        .string()
        .optional()
        .describe(
          "Optional additional context about the codebase or problem domain to include with the prompt."
        ),
    },
    outputSchema: {
      modelsQueried: z.number().describe("Number of models queried"),
      responses: z
        .array(
          z.object({
            model: z.string().describe("Model name and provider"),
            response: z.string().nullable().describe("Model response text, or null on error"),
            error: z.string().nullable().describe("Error message, or null on success"),
            latencyMs: z.number().describe("Response latency in milliseconds"),
            authMethod: z
              .enum(["oauth", "oauth-subscription", "apikey", "none"])
              .describe("Authentication method used"),
          })
        )
        .describe("Individual model responses"),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ prompt, models, context }, extra) => {
    const fullPrompt = context
      ? `Context:\n${context}\n\n---\n\nPlease consider all possible approaches from various perspectives. Do not yet begin planning or implementation.\n\n${prompt}`
      : `Please consider all possible approaches from various perspectives. Do not yet begin planning or implementation.\n\n${prompt}`;

    // Emit progress notifications as each model completes
    const progressToken = extra._meta?.progressToken;

    const results = await queryAllModels(fullPrompt, models, async (completed, total, model) => {
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress" as const,
          params: {
            progressToken,
            progress: completed,
            total,
            message: `${model} responded (${completed}/${total})`,
          },
        });
      }
    }, extra.signal);

    const formatted = formatCouncilResults(results);

    // Structured content for typed host consumption
    const structured = {
      modelsQueried: results.length,
      responses: results.map((r) => ({
        model: r.model,
        response: r.response,
        error: r.error,
        latencyMs: r.latencyMs,
        authMethod: r.authMethod,
      })),
    };

    return {
      content: [{ type: "text" as const, text: formatted }],
      structuredContent: structured,
    };
  }
);

// --- Setup tool (guided first-run) ---

server.registerTool(
  "brainstew_setup",
  {
    description:
      "Check which providers are configured and guide setup. Call this on first use or when providers return auth errors. Shows what's configured, what's missing, and tells the user exactly what to do next.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    const store = await loadAuthStore();
    const lines: string[] = ["# Brainstew Setup\n"];

    const configured: string[] = [];
    const missing: string[] = [];

    for (const [id, info] of Object.entries(PROVIDER_AUTH_SUPPORT)) {
      const hasEnvKey = !!process.env[info.envVar];

      // Check all OAuth configs for this provider
      let oauthActive = false;
      let oauthMethod = "";
      for (const oauthId of info.oauthProviderIds) {
        const stored = store[oauthId];
        if (
          stored?.type === "oauth" &&
          stored.oauth?.accessToken
        ) {
          const notExpired =
            !stored.oauth.expiresAt || stored.oauth.expiresAt > Date.now();
          const canRefresh = !!stored.oauth.refreshToken;

          if (notExpired || canRefresh) {
            oauthActive = true;
            const label =
              oauthId === "google_antigravity"
                ? "Antigravity"
                : oauthId === "openai_codex"
                  ? "ChatGPT subscription"
                  : "standard";
            oauthMethod = notExpired
              ? `OAuth (${label})`
              : `OAuth (${label}, will auto-refresh)`;
            break;
          }
        }
      }

      const hasStoredKey = store[id]?.type === "apikey" && !!store[id].apiKey;

      if (oauthActive || hasEnvKey || hasStoredKey) {
        const method = oauthActive
          ? oauthMethod
          : hasEnvKey
            ? `API key (${info.envVar})`
            : "API key (stored)";
        configured.push(`- **${info.name}**: ${method}`);
      } else {
        const howToParts: string[] = [];
        if (info.oauthProviderIds.includes("google_antigravity")) {
          howToParts.push(
            "`brainstew_login` with `google-antigravity` (zero setup, recommended)"
          );
        }
        if (info.oauthProviderIds.includes("openai_codex")) {
          howToParts.push(
            "`brainstew_login` with `openai` (uses ChatGPT Plus/Pro subscription)"
          );
        }
        if (info.oauthProviderIds.includes("google")) {
          howToParts.push(
            "`brainstew_login` with `google` (requires Cloud Console client ID)"
          );
        }
        howToParts.push(`Set \`${info.envVar}\` env var (${info.keyUrl})`);
        missing.push(`- **${info.name}**: ${howToParts.join(", or ")}`);
      }
    }

    if (configured.length > 0) {
      lines.push("## Ready to use\n");
      lines.push(...configured);
      lines.push("");
    }

    if (missing.length > 0) {
      lines.push("## Needs configuration\n");
      lines.push(...missing);
      lines.push("");
      lines.push(
        "**To configure:** Call `brainstew_login` with the recommended provider, or ask the user to set env vars and restart the MCP server."
      );
    } else {
      lines.push(
        "All providers are configured. Run `brainstew_council` to start deliberating."
      );
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Login tool (Phase 1: start OAuth, return URL immediately) ---

server.registerTool(
  "brainstew_login",
  {
    description:
      "Start OAuth login for a provider. Only needed when a provider is not yet configured, or the user explicitly wants to switch from API key to OAuth. Do NOT call this if the provider already shows as configured in brainstew_setup.\n\n" +
      "IMPORTANT: Only one login flow can be active at a time. Starting a new login cancels any in-progress flow. Do NOT call this for multiple providers in parallel.\n\n" +
      "Options:\n" +
      "- 'google-antigravity': Zero-setup Google OAuth via Antigravity (for Gemini)\n" +
      "- 'openai': ChatGPT Plus/Pro subscription OAuth (for GPT/Codex models)\n" +
      "- 'google': Standard Google OAuth (requires GOOGLE_OAUTH_CLIENT_ID env var from Cloud Console)",
    inputSchema: {
      provider: z
        .enum(["google", "google-antigravity", "openai"])
        .describe(
          "Which provider to authenticate with. Use 'google-antigravity' for zero-setup Gemini access, 'openai' for ChatGPT subscription, or 'google' for standard Google OAuth."
        ),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
  },
  async ({ provider }) => {
    // Map user-facing name to internal OAuth config ID
    const internalId = LOGIN_PROVIDER_MAP[provider];
    if (!internalId) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Unknown provider "${provider}". Use 'google-antigravity', 'openai', or 'google'.`,
          },
        ],
      };
    }

    const config = PROVIDER_OAUTH_CONFIGS[internalId];
    if (!config) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Provider "${provider}" does not have an OAuth configuration. Run brainstew_setup for guidance.`,
          },
        ],
      };
    }

    // For standard Google OAuth, require a client ID from env
    if (internalId === "google" && !config.clientId) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              "Standard Google OAuth requires a Cloud Console client ID. " +
              "Set the GOOGLE_OAUTH_CLIENT_ID env var first, or use 'google-antigravity' instead (zero setup needed).",
          },
        ],
      };
    }

    // Find the friendly name
    const friendlyName =
      provider === "google-antigravity"
        ? "Google Gemini (Antigravity)"
        : provider === "openai"
          ? "OpenAI (ChatGPT subscription)"
          : "Google (standard OAuth)";

    try {
      const flow = startOAuthLogin(internalId, config);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `## OAuth Login for ${friendlyName}\n`,
              `**The user must open this URL in their browser to authorize:**\n`,
              flow.authorizationUrl,
              `\nA browser window may have opened automatically. If not, the user needs to copy and open the URL above.`,
              `\nAfter the user completes authorization in the browser, call **brainstew_login_callback** to finish authentication.`,
              `\n**If the redirect fails** (Docker, SSH, Safari HTTPS-Only): the user should copy the full URL from the browser's address bar after authorizing, then call **brainstew_login_callback** with that URL as the \`callback_url\` parameter.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to start OAuth flow for ${friendlyName}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }
);

// --- Login callback tool (Phase 2: await browser callback) ---

server.registerTool(
  "brainstew_login_callback",
  {
    description:
      "Complete an OAuth login started by brainstew_login. Call this AFTER the user has opened the authorization URL in their browser and completed the consent flow.\n\n" +
      "Two modes:\n" +
      "- **Automatic** (no params): Waits for the browser redirect to reach the localhost callback server. Works in most environments.\n" +
      "- **Manual** (with callback_url): For Docker, SSH, or Safari HTTPS-Only environments where the localhost redirect fails. The user copies the full URL from the browser's address bar after authorizing and provides it here.",
    inputSchema: {
      callback_url: z
        .string()
        .optional()
        .describe(
          "Optional. If the browser redirect failed (Docker, SSH, Safari HTTPS-Only), paste the full URL from the browser's address bar here. It starts with http://localhost... and contains the authorization code."
        ),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
  },
  async ({ callback_url }) => {
    const flow = getActivePendingFlow();
    if (!flow) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "No OAuth flow in progress. Call brainstew_login first to start one.",
          },
        ],
      };
    }

    try {
      const credentials = callback_url
        ? await completeOAuthManually(callback_url)
        : await awaitOAuthCallback();

      const expiresIn = credentials.expiresAt
        ? Math.round((credentials.expiresAt - Date.now()) / 60_000)
        : "unknown";

      const providerLabel =
        flow.providerId === "google_antigravity"
          ? "Google Gemini (Antigravity)"
          : flow.providerId === "openai_codex"
            ? "OpenAI (ChatGPT subscription)"
            : flow.providerId;

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully authenticated with ${providerLabel} via OAuth. Token expires in ${expiresIn} minutes. Credentials stored securely in OS keychain.`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `OAuth callback failed: ${err instanceof Error ? err.message : String(err)}. Try running brainstew_login again, or use an API key instead (see brainstew_setup).`,
          },
        ],
      };
    }
  }
);

// --- Auth status tool ---

server.registerTool(
  "brainstew_auth_status",
  {
    description:
      "Check which providers are authenticated and how (OAuth vs API key vs subscription OAuth). Shows credential status, expiration, and auth method for all providers.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    const store = await loadAuthStore();
    const lines: string[] = [
      "# Brainstew Auth Status\n",
      "| Provider | Status | Auth Method |",
      "|----------|--------|-------------|",
    ];

    for (const [id, info] of Object.entries(PROVIDER_AUTH_SUPPORT)) {
      const hasEnvKey = !!process.env[info.envVar];

      // Check OAuth configs
      let oauthStatus = "";
      for (const oauthId of info.oauthProviderIds) {
        const stored = store[oauthId];
        if (
          stored?.type === "oauth" &&
          stored.oauth?.accessToken
        ) {
          const expired =
            stored.oauth.expiresAt && stored.oauth.expiresAt < Date.now();
          const expiresIn = stored.oauth.expiresAt
            ? Math.round((stored.oauth.expiresAt - Date.now()) / 60_000)
            : null;

          const label =
            oauthId === "google_antigravity"
              ? "Antigravity"
              : oauthId === "openai_codex"
                ? "ChatGPT subscription"
                : "standard";

          if (expired) {
            oauthStatus = `${label} OAuth (expired, has refresh token: ${stored.oauth.refreshToken ? "yes" : "no"})`;
          } else {
            oauthStatus = `${label} OAuth active${expiresIn !== null ? ` (expires in ${expiresIn} min)` : ""}`;
          }
          break;
        }
      }

      const hasStoredKey = store[id]?.type === "apikey" && !!store[id].apiKey;

      let status: string;
      if (oauthStatus) {
        status = oauthStatus;
      } else if (hasEnvKey) {
        status = `Ready (${info.envVar})`;
      } else if (hasStoredKey) {
        status = "Ready (stored key)";
      } else {
        status = "Not configured";
      }

      const methods: string[] = [];
      if (info.oauthProviderIds.length > 0) methods.push("OAuth");
      if (info.apiKey) methods.push("API key");
      const method = methods.join(" or ");

      lines.push(`| ${info.name} | ${status} | ${method} |`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Formatting ---

function formatCouncilResults(results: ModelResponse[]): string {
  const sections: string[] = [
    "# Model Council Results\n",
    `Queried ${results.length} model(s) in parallel.\n`,
  ];

  const failedModels: string[] = [];

  for (const result of results) {
    sections.push(`## ${result.model}`);
    if (result.error) {
      sections.push(`**Error**: ${result.error}\n`);
      if (result.authMethod === "none") {
        failedModels.push(result.model);
      }
    } else {
      sections.push(`${result.response}\n`);
    }
    sections.push(
      `*Latency: ${result.latencyMs}ms | Auth: ${result.authMethod}*\n`
    );
  }

  if (failedModels.length > 0) {
    sections.push("---");
    sections.push(
      `**${failedModels.length} model(s) failed.** Tokens may be revoked upstream even if brainstew_auth_status shows them as active. ` +
      `To fix: re-authenticate the failing provider(s) with brainstew_login (one at a time, sequentially). ` +
      `If the error is not auth-related (e.g., 400 Bad Request), the issue may be an API format problem — check the error message above.`
    );
  }

  sections.push("---");
  sections.push(
    "**You are the synthesizer.** Review the responses above. Identify where the models agree, where they disagree, and any unique insights. Then produce your optimal synthesized response."
  );

  return sections.join("\n");
}

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Brainstew server failed to start:", err);
  process.exit(1);
});
