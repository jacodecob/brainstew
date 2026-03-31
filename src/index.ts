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

const server = new McpServer({
  name: "brainstew",
  version: "0.2.0",
});

// --- Council tool ---

server.tool(
  "brainstew_council",
  "Fan out a prompt to multiple AI models (GPT, Gemini, Grok) in parallel and return their diverse perspectives. Use this when facing complex questions, architectural decisions, or any situation where multiple viewpoints would help you synthesize a better answer. You are the synthesizer — review the responses, identify where models agree and disagree, and produce an optimal final answer.",
  {
    prompt: z
      .string()
      .describe(
        "The question or problem to send to all models. Frame it as: 'Please consider all possible approaches from various perspectives, do not yet begin planning or implementation.' followed by the actual question."
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
  async ({ prompt, models, context }) => {
    const fullPrompt = context
      ? `Context:\n${context}\n\n---\n\nPlease consider all possible approaches from various perspectives. Do not yet begin planning or implementation.\n\n${prompt}`
      : `Please consider all possible approaches from various perspectives. Do not yet begin planning or implementation.\n\n${prompt}`;

    const results = await queryAllModels(fullPrompt, models);
    const formatted = formatCouncilResults(results);

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

// --- Login tool ---

server.tool(
  "brainstew_login",
  "Authenticate with an AI provider via OAuth. Opens a browser-based OAuth flow for the specified provider. Use this when a provider returns an auth error and you need to log in. After login, credentials are stored locally at ~/.brainstew/auth.json and auto-refresh on expiry.",
  {
    provider: z
      .enum(["openai", "google"])
      .describe(
        "Which provider to authenticate with. xAI/Grok does not support OAuth (use XAI_API_KEY env var)."
      ),
  },
  async ({ provider }) => {
    const config = PROVIDER_OAUTH_CONFIGS[provider];
    if (!config) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Provider "${provider}" does not have OAuth configured.`,
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
            text: `Successfully authenticated with ${provider} via OAuth. Credentials stored at ~/.brainstew/auth.json.`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          {
            type: "text" as const,
            text: `OAuth login failed for ${provider}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }
);

// --- Auth status tool ---

server.tool(
  "brainstew_auth_status",
  "Check which providers are authenticated and how (OAuth vs API key). Shows credential status for all configured providers.",
  {},
  async () => {
    const store = await loadAuthStore();
    const lines: string[] = ["# Brainstew Auth Status\n"];

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
        status = `OAuth (expires in ${expiresIn} min)`;
      } else if (hasEnvKey) {
        status = `API key (${p.envVar})`;
      } else if (stored?.type === "apikey") {
        status = "API key (stored)";
      } else {
        status = "Not configured";
      }

      lines.push(
        `| ${p.name} | ${status} | OAuth: ${p.supportsOAuth ? "supported" : "not available"} |`
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
