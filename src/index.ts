import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryAllModels, type ModelResponse } from "./providers.js";

const server = new McpServer({
  name: "brainstew",
  version: "0.1.0",
});

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
      content: [
        {
          type: "text" as const,
          text: formatted,
        },
      ],
    };
  }
);

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
    sections.push(`*Latency: ${result.latencyMs}ms*\n`);
  }

  sections.push("---");
  sections.push(
    "**You are the synthesizer.** Review the responses above. Identify where the models agree, where they disagree, and any unique insights. Then produce your optimal synthesized response."
  );

  return sections.join("\n");
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Brainstew server failed to start:", err);
  process.exit(1);
});
