import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryAllModels, type ModelResponse } from "./providers.js";
import {
  performOAuthLogin,
  loadAuthStore,
  saveAuthStore,
  PROVIDER_OAUTH_CONFIGS,
  PROVIDER_AUTH_SUPPORT,
} from "./auth.js";

const server = new McpServer(
  {
    name: "brainstew",
    version: "0.4.0",
  },
  {
    instructions:
      "Brainstew is a multi-model deliberation server. Call brainstew_council to fan out a prompt to GPT, Gemini, and Grok in parallel. On first use, call brainstew_setup to check which providers are configured and guide the user through setup. Do NOT call brainstew_login unless the user explicitly asks for OAuth — most providers use API keys. Use brainstew_auth_status to check credential state.",
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

// --- Setup tool (guided first-run) ---

server.registerTool(
  "brainstew_setup",
  {
    description:
      "Check which providers are configured and guide setup. Call this on first use or when providers return auth errors. Shows what's configured, what's missing, and tells the user exactly what env vars to set. Do NOT call brainstew_login instead — most providers require API keys, not OAuth.",
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
      const stored = store[id];
      const oauthActive =
        stored?.type === "oauth" &&
        stored.oauth?.accessToken &&
        (!stored.oauth.expiresAt || stored.oauth.expiresAt > Date.now());
      const hasStoredKey = stored?.type === "apikey" && !!stored.apiKey;

      if (oauthActive || hasEnvKey || hasStoredKey) {
        const method = oauthActive
          ? "OAuth"
          : hasEnvKey
            ? `API key (${info.envVar})`
            : "API key (stored)";
        configured.push(`- **${info.name}**: ${method}`);
      } else {
        const howTo = info.oauth
          ? `Set \`${info.envVar}\` env var (${info.keyUrl}), or use \`brainstew_login\` for OAuth`
          : `Set \`${info.envVar}\` env var — get a key at ${info.keyUrl}`;
        missing.push(`- **${info.name}**: ${howTo}`);
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
        "**To configure:** Ask the user to set the env vars listed above, then restart the MCP server. " +
          "The user can add env vars to the MCP config in Claude Code settings, or to a `.env` file in the project."
      );
    } else {
      lines.push("All providers are configured. Run `brainstew_council` to start deliberating.");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Login tool (OAuth only — limited to providers that actually support it) ---

server.registerTool(
  "brainstew_login",
  {
    description:
      "Authenticate with a provider via OAuth. Only Google supports OAuth — OpenAI and xAI require API keys (use brainstew_setup for guidance). Do NOT call this unless the user explicitly asks for OAuth login. For most setups, API keys via env vars are simpler and recommended.",
    inputSchema: {
      provider: z
        .enum(["google"])
        .describe(
          "Which provider to authenticate with via OAuth. Only Google is supported. OpenAI and xAI use API keys only."
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
            text: `Provider "${provider}" does not support OAuth. Run brainstew_setup for configuration guidance.`,
          },
        ],
      };
    }

    if (!config.clientId) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `OAuth for ${provider} requires a Google Cloud OAuth client ID. Set the GOOGLE_OAUTH_CLIENT_ID env var, or use an API key instead (set ${PROVIDER_AUTH_SUPPORT[provider]?.envVar ?? "the API key env var"}).`,
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
            text: `Successfully authenticated with ${provider} via OAuth. Credentials stored securely in OS keychain. Tokens will auto-refresh on expiry.`,
          },
        ],
      };
    } catch (err: unknown) {
      const info = PROVIDER_AUTH_SUPPORT[provider];
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `OAuth login failed for ${provider}: ${err instanceof Error ? err.message : String(err)}. ` +
              (info ? `Alternative: set ${info.envVar} env var (${info.keyUrl}).` : "Try setting the API key env var instead."),
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
      "Check which providers are authenticated and how (OAuth vs API key). Shows credential status, expiration, and auth method for all providers.",
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
      const stored = store[id];
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
        status = `Ready (${info.envVar})`;
      } else if (stored?.type === "apikey") {
        status = "Ready (stored key)";
      } else {
        status = "Not configured";
      }

      const method = info.oauth ? "API key or OAuth" : "API key only";

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
