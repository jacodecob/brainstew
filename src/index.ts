import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryAllModels, type ModelResponse } from "./providers.js";
import {
  performOAuthLogin,
  loadAuthStore,
  saveAuthStore,
  PROVIDER_OAUTH_CONFIGS,
} from "./auth.js";

const server = new McpServer(
  {
    name: "brainstew",
    version: "0.3.0",
  },
  {
    instructions:
      "Brainstew is a multi-model deliberation server. Call brainstew_council to fan out a prompt to GPT, Gemini, and Grok in parallel. If a provider returns an auth error, call brainstew_login to authenticate via OAuth. Use brainstew_auth_status to check credential state before troubleshooting.",
  }
);

// --- Council tool ---

server.registerTool(
  "brainstew_council",
  {
    description:
      "Fan out a prompt to multiple AI models (GPT, Gemini, Grok) in parallel and return their diverse perspectives. Use this for complex questions, architectural decisions, or any situation where multiple viewpoints improve synthesis. Does NOT store or modify data — read-only queries to external model APIs. If a model returns an auth error, call brainstew_login to re-authenticate that provider via OAuth.",
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
              .enum(["oauth", "apikey", "none"])
              .describe("Authentication method used"),
          })
        )
        .describe("Individual model responses"),
    },
    annotations: {
      readOnlyHint: true,
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
    });

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

// --- Login tool ---

server.registerTool(
  "brainstew_login",
  {
    description:
      "Authenticate with an AI provider via OAuth. Opens a browser-based PKCE OAuth flow. Use this when brainstew_council returns an auth error for a provider. Stores credentials in the OS keychain (falls back to ~/.brainstew/auth.json) with auto-refresh. Only supports OpenAI and Google — xAI/Grok requires the XAI_API_KEY env var (no OAuth).",
    inputSchema: {
      provider: z
        .enum(["openai", "google"])
        .describe(
          "Which provider to authenticate with. xAI/Grok does not support OAuth — use XAI_API_KEY env var instead."
        ),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
  },
  async ({ provider }) => {
    const config = PROVIDER_OAUTH_CONFIGS[provider];
    if (!config) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Provider "${provider}" does not have OAuth configured. Use brainstew_auth_status to check which providers support OAuth.`,
          },
        ],
      };
    }

    try {
      const credentials = await performOAuthLogin(provider, config);
      const store = await loadAuthStore();
      store[provider] = { type: "oauth", oauth: credentials };
      await saveAuthStore(store);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully authenticated with ${provider} via OAuth. Credentials stored securely in OS keychain. OAuth tokens will auto-refresh on expiry.`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `OAuth login failed for ${provider}: ${err instanceof Error ? err.message : String(err)}. Retry with brainstew_login or fall back to setting the API key env var.`,
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
      "Check which providers are authenticated and how (OAuth vs API key). Shows credential status, expiration, and OAuth support for all providers. Call this before troubleshooting auth issues.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    const store = await loadAuthStore();
    const lines: string[] = [
      "# Brainstew Auth Status\n",
      "| Provider | Status | OAuth Support |",
      "|----------|--------|---------------|",
    ];

    const providers = [
      {
        id: "openai",
        name: "OpenAI (GPT)",
        envVar: "OPENAI_API_KEY",
        supportsOAuth: true,
      },
      {
        id: "google",
        name: "Google (Gemini)",
        envVar: "GEMINI_API_KEY",
        supportsOAuth: true,
      },
      {
        id: "xai",
        name: "xAI (Grok)",
        envVar: "XAI_API_KEY",
        supportsOAuth: false,
      },
    ];

    for (const p of providers) {
      const hasEnvKey = !!process.env[p.envVar];
      const stored = store[p.id];
      const oauthActive =
        stored?.type === "oauth" &&
        stored.oauth?.accessToken &&
        (!stored.oauth.expiresAt || stored.oauth.expiresAt > Date.now());

      let status: string;
      if (oauthActive) {
        const expiresIn = stored.oauth!.expiresAt
          ? Math.round((stored.oauth!.expiresAt - Date.now()) / 60_000)
          : "unknown";
        status = `OAuth active (expires in ${expiresIn} min)`;
      } else if (hasEnvKey) {
        status = `API key fallback (${p.envVar})`;
      } else if (stored?.type === "apikey") {
        status = "API key (stored)";
      } else {
        status = "Not configured — use brainstew_login or set env var";
      }

      lines.push(
        `| ${p.name} | ${status} | ${p.supportsOAuth ? "Yes" : "No (API key only)"} |`
      );
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

  for (const result of results) {
    sections.push(`## ${result.model}`);
    if (result.error) {
      sections.push(`**Error**: ${result.error}\n`);
    } else {
      sections.push(`${result.response}\n`);
    }
    sections.push(
      `*Latency: ${result.latencyMs}ms | Auth: ${result.authMethod}*\n`
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
