import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface ModelResponse {
  model: string;
  response: string | null;
  error: string | null;
  latencyMs: number;
}

type ModelKey = "gpt" | "gemini" | "grok";

async function queryGPT(prompt: string): Promise<ModelResponse> {
  const start = Date.now();
  try {
    const client = new OpenAI(); // uses OPENAI_API_KEY env var
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    });
    return {
      model: "GPT-4o (OpenAI)",
      response: res.choices[0]?.message?.content ?? "(empty response)",
      error: null,
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      model: "GPT-4o (OpenAI)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}

async function queryGemini(prompt: string): Promise<ModelResponse> {
  const start = Date.now();
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const res = await model.generateContent(prompt);
    return {
      model: "Gemini 2.0 Flash (Google)",
      response: res.response.text(),
      error: null,
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      model: "Gemini 2.0 Flash (Google)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}

async function queryGrok(prompt: string): Promise<ModelResponse> {
  const start = Date.now();
  try {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY not set");
    // xAI uses OpenAI-compatible API
    const client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
    });
    const res = await client.chat.completions.create({
      model: "grok-3",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    });
    return {
      model: "Grok 3 (xAI)",
      response: res.choices[0]?.message?.content ?? "(empty response)",
      error: null,
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      model: "Grok 3 (xAI)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}

const providers: Record<ModelKey, (prompt: string) => Promise<ModelResponse>> =
  {
    gpt: queryGPT,
    gemini: queryGemini,
    grok: queryGrok,
  };

export async function queryAllModels(
  prompt: string,
  models: ModelKey[]
): Promise<ModelResponse[]> {
  const queries = models.map((key) => providers[key](prompt));
  return Promise.all(queries);
}
