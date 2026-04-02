import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  getAccessToken,
  PROVIDER_OAUTH_CONFIGS,
  type OAuthCredentials,
} from "./auth.js";

export interface ModelResponse {
  model: string;
  response: string | null;
  error: string | null;
  latencyMs: number;
  authMethod: "oauth" | "apikey" | "none";
}

type ModelKey = "gpt" | "gemini" | "grok";

async function queryGPT(prompt: string): Promise<ModelResponse> {
  const start = Date.now();
  try {
    // OAuth first, API key fallback
    const { token, type } = await getAccessToken(
      "openai",
      PROVIDER_OAUTH_CONFIGS.openai,
      process.env.OPENAI_API_KEY
    );

    const client = new OpenAI({
      apiKey: token,
      ...(type === "oauth" && {
        defaultHeaders: { Authorization: `Bearer ${token}` },
      }),
    });

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
      authMethod: type,
    };
  } catch (err: unknown) {
    return {
      model: "GPT-4o (OpenAI)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
      authMethod: "none",
    };
  }
}

async function queryGemini(prompt: string): Promise<ModelResponse> {
  const start = Date.now();
  try {
    // OAuth first, API key fallback
    const { token, type } = await getAccessToken(
      "google",
      PROVIDER_OAUTH_CONFIGS.google,
      process.env.GEMINI_API_KEY
    );

    if (type === "oauth") {
      // Use REST API with OAuth bearer token (Vertex AI / Generative Language API)
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
          }),
        }
      );

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini API error (${res.status}): ${body}`);
      }

      const data = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      return {
        model: "Gemini 2.0 Flash (Google)",
        response: text ?? "(empty response)",
        error: null,
        latencyMs: Date.now() - start,
        authMethod: "oauth",
      };
    }

    // API key path
    const client = new GoogleGenerativeAI(token);
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const res = await model.generateContent(prompt);

    return {
      model: "Gemini 2.0 Flash (Google)",
      response: res.response.text(),
      error: null,
      latencyMs: Date.now() - start,
      authMethod: "apikey",
    };
  } catch (err: unknown) {
    return {
      model: "Gemini 2.0 Flash (Google)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
      authMethod: "none",
    };
  }
}

async function queryGrok(prompt: string): Promise<ModelResponse> {
  const start = Date.now();
  try {
    // xAI does not support OAuth — API key only
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "XAI_API_KEY not set. xAI does not support OAuth — API key required."
      );
    }

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
      authMethod: "apikey",
    };
  } catch (err: unknown) {
    return {
      model: "Grok 3 (xAI)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
      authMethod: "none",
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
  models: ModelKey[],
  onModelComplete?: (completed: number, total: number, model: string) => void
): Promise<ModelResponse[]> {
  const total = models.length;
  let completed = 0;

  const queries = models.map(async (key) => {
    const result = await providers[key](prompt);
    completed++;
    onModelComplete?.(completed, total, result.model);
    return result;
  });

  return Promise.all(queries);
}
