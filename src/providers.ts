import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  resolveCredentials,
  refreshOAuthToken,
  loadAuthStore,
  saveAuthStore,
} from "./auth.js";
import {
  PROVIDER_OAUTH_CONFIGS,
  ANTIGRAVITY_ENDPOINTS,
  discoverAntigravityProject,
  buildAntigravityHeaders,
  buildAntigravityBody,
  CODEX_API_ENDPOINT,
  extractCodexAccountId,
  buildCodexHeaders,
  buildCodexBody,
} from "./oauth-configs.js";
import { resilientFetch, antigravityFetchWithFallback } from "./fetch.js";

export interface ModelResponse {
  model: string;
  response: string | null;
  error: string | null;
  latencyMs: number;
  authMethod: "oauth" | "oauth-subscription" | "apikey" | "none";
}

type ModelKey = "gpt" | "gemini" | "grok";

// --- Helper: build a token refresh callback for resilientFetch ---

function makeRefreshCallback(
  oauthProviderId: string
): () => Promise<string | null> {
  return async () => {
    const config = PROVIDER_OAUTH_CONFIGS[oauthProviderId];
    if (!config) return null;

    const store = await loadAuthStore();
    const creds = store[oauthProviderId];
    if (!creds?.oauth?.refreshToken) return null;

    try {
      const refreshed = await refreshOAuthToken(config, creds.oauth);
      store[oauthProviderId] = { type: "oauth", oauth: refreshed };
      await saveAuthStore(store);
      return refreshed.accessToken;
    } catch {
      return null;
    }
  };
}

// --- GPT ---

async function queryGPT(prompt: string, signal?: AbortSignal): Promise<ModelResponse> {
  const start = Date.now();
  try {
    const { token, type, oauthProviderId } = await resolveCredentials(
      "openai",
      process.env.OPENAI_API_KEY
    );

    // Codex subscription OAuth path
    if (type === "oauth" && oauthProviderId === "openai_codex") {
      return await queryGPTCodex(prompt, token, oauthProviderId, start, signal);
    }

    // Standard API key path
    const client = new OpenAI({ apiKey: token });
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    }, { signal });

    return {
      model: "GPT-4o (OpenAI)",
      response: res.choices[0]?.message?.content ?? "(empty response)",
      error: null,
      latencyMs: Date.now() - start,
      authMethod: "apikey",
    };
  } catch (err: unknown) {
    return {
      model: "GPT (OpenAI)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
      authMethod: "none",
    };
  }
}

async function queryGPTCodex(
  prompt: string,
  token: string,
  oauthProviderId: string,
  start: number,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const accountId = extractCodexAccountId(token);
  const headers = buildCodexHeaders(token, accountId);
  const body = buildCodexBody(prompt, "gpt-5.1-codex");

  const res = await resilientFetch(CODEX_API_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, {
    refreshToken: makeRefreshCallback(oauthProviderId),
    signal,
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`Codex API error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  // Extract text from Responses API output format
  const textParts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type === "message" && item.content) {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) {
          textParts.push(part.text);
        }
      }
    }
  }

  return {
    model: "GPT-5.1 Codex (OpenAI)",
    response: textParts.join("\n") || "(empty response)",
    error: null,
    latencyMs: Date.now() - start,
    authMethod: "oauth-subscription",
  };
}

// --- Gemini ---

async function queryGemini(prompt: string, signal?: AbortSignal): Promise<ModelResponse> {
  const start = Date.now();
  try {
    const { token, type, oauthProviderId } = await resolveCredentials(
      "google",
      process.env.GEMINI_API_KEY
    );

    // Antigravity subscription OAuth path
    if (type === "oauth" && oauthProviderId === "google_antigravity") {
      return await queryGeminiAntigravity(prompt, token, oauthProviderId, start, signal);
    }

    // Standard Google OAuth path (Generative Language API with bearer token)
    if (type === "oauth") {
      return await queryGeminiStandardOAuth(
        prompt,
        token,
        oauthProviderId ?? "google",
        start,
        signal
      );
    }

    // API key path (Google AI SDK)
    const client = new GoogleGenerativeAI(token);
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const res = await model.generateContent(prompt, { signal });

    return {
      model: "Gemini 2.0 Flash (Google)",
      response: res.response.text(),
      error: null,
      latencyMs: Date.now() - start,
      authMethod: "apikey",
    };
  } catch (err: unknown) {
    return {
      model: "Gemini (Google)",
      response: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
      authMethod: "none",
    };
  }
}

async function queryGeminiStandardOAuth(
  prompt: string,
  token: string,
  oauthProviderId: string,
  start: number,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const res = await resilientFetch(
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
    },
    {
      refreshToken: makeRefreshCallback(oauthProviderId),
      signal,
    }
  );

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
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

async function queryGeminiAntigravity(
  prompt: string,
  token: string,
  oauthProviderId: string,
  start: number,
  signal?: AbortSignal
): Promise<ModelResponse> {
  // Discover the Antigravity project ID (cached after first call)
  const project = await discoverAntigravityProject(token);

  const model = "gemini-2.5-pro";
  const headers = buildAntigravityHeaders(token);
  const body = buildAntigravityBody(prompt, project, model);

  const res = await antigravityFetchWithFallback(
    "/v1internal:generateContent",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    ANTIGRAVITY_ENDPOINTS,
    {
      refreshToken: makeRefreshCallback(oauthProviderId),
      signal,
    }
  );

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`Antigravity API error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  return {
    model: "Gemini 2.5 Pro (Google Antigravity)",
    response: text ?? "(empty response)",
    error: null,
    latencyMs: Date.now() - start,
    authMethod: "oauth-subscription",
  };
}

// --- Grok ---

async function queryGrok(prompt: string, signal?: AbortSignal): Promise<ModelResponse> {
  const start = Date.now();
  try {
    const { token } = await resolveCredentials("xai", process.env.XAI_API_KEY);

    const client = new OpenAI({
      apiKey: token,
      baseURL: "https://api.x.ai/v1",
    });

    const res = await client.chat.completions.create({
      model: "grok-3",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    }, { signal });

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

// --- Concurrent dispatch ---

const providers: Record<ModelKey, (prompt: string, signal?: AbortSignal) => Promise<ModelResponse>> =
  {
    gpt: queryGPT,
    gemini: queryGemini,
    grok: queryGrok,
  };

export async function queryAllModels(
  prompt: string,
  models: ModelKey[],
  onModelComplete?: (completed: number, total: number, model: string) => void,
  signal?: AbortSignal
): Promise<ModelResponse[]> {
  const total = models.length;
  let completed = 0;

  const queries = models.map(async (key) => {
    const result = await providers[key](prompt, signal);
    completed++;
    onModelComplete?.(completed, total, result.model);
    return result;
  });

  const settled = await Promise.allSettled(queries);

  return settled.map((outcome, i) => {
    if (outcome.status === "fulfilled") return outcome.value;
    // Unexpected rejection — wrap as error response
    return {
      model: `${models[i]} (unknown)`,
      response: null,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      latencyMs: 0,
      authMethod: "none" as const,
    };
  });
}
