// --- Provider OAuth Configurations & Helpers ---
// All provider-specific OAuth constants, request builders, and metadata.

import { randomBytes } from "node:crypto";
import { resilientFetch } from "./fetch.js";

// --- Types ---

export interface ProviderOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  callbackPort: number;
  callbackPath?: string; // defaults to "/callback"
  callbackHostname?: string; // defaults to "127.0.0.1"
  usePkce: boolean;
  extraAuthParams?: Record<string, string>;
}

export interface ProviderAuthInfo {
  oauth: boolean;
  apiKey: boolean;
  envVar: string;
  name: string;
  keyUrl: string;
  oauthProviderIds: string[]; // OAuth config IDs to try in priority order
}

// --- OAuth Provider Configs ---

export const PROVIDER_OAUTH_CONFIGS: Record<string, ProviderOAuthConfig> = {
  // Standard Google Desktop OAuth — requires Cloud Console setup
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    callbackPort: 1456,
    usePkce: true,
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },

  // Google Antigravity — zero setup, emulates Gemini CLI environment
  google_antigravity: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId:
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    callbackPort: 51121,
    callbackPath: "/oauth-callback",
    callbackHostname: "localhost",
    usePkce: true,
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },

  // OpenAI Codex — ChatGPT Plus/Pro subscription OAuth
  openai_codex: {
    authUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    scopes: ["openid", "profile", "email", "offline_access"],
    callbackPort: 1455,
    callbackPath: "/auth/callback",
    callbackHostname: "localhost",
    usePkce: true,
    extraAuthParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "opencode",
    },
  },
};

// --- Provider Auth Support Metadata ---

export const PROVIDER_AUTH_SUPPORT: Record<string, ProviderAuthInfo> = {
  openai: {
    oauth: true,
    apiKey: true,
    envVar: "OPENAI_API_KEY",
    name: "OpenAI (GPT)",
    keyUrl: "https://platform.openai.com/api-keys",
    oauthProviderIds: ["openai_codex"],
  },
  google: {
    oauth: true,
    apiKey: true,
    envVar: "GEMINI_API_KEY",
    name: "Google (Gemini)",
    keyUrl: "https://aistudio.google.com/apikey",
    oauthProviderIds: ["google_antigravity", "google"],
  },
  xai: {
    oauth: false,
    apiKey: true,
    envVar: "XAI_API_KEY",
    name: "xAI (Grok)",
    keyUrl: "https://console.x.ai",
    oauthProviderIds: [],
  },
};

// --- Antigravity Constants & Helpers ---

export const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;

const DEFAULT_ANTIGRAVITY_PROJECT = "rising-fact-p41fc";

// Cache project ID per session (doesn't change during a server run)
let cachedAntigravityProject: string | null = null;

export async function discoverAntigravityProject(
  token: string
): Promise<string> {
  if (cachedAntigravityProject) return cachedAntigravityProject;

  // Try each endpoint for project discovery (production first for discovery)
  const discoveryEndpoints = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  ];

  for (const endpoint of discoveryEndpoints) {
    try {
      const platformId = process.platform === "darwin" ? "MACOS" : "PLATFORM_UNSPECIFIED";
      const res = await resilientFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "google-api-nodejs-client/9.15.1",
          "Client-Metadata": JSON.stringify({
            ideType: "ANTIGRAVITY",
            platform: platformId,
            pluginType: "GEMINI",
          }),
        },
        body: JSON.stringify({
          metadata: {
            ideType: "ANTIGRAVITY",
            platform: platformId,
            pluginType: "GEMINI",
          },
        }),
        signal: AbortSignal.timeout(10_000),
      }, { maxRetries: 1 });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        cloudaicompanionProject?: string | { id: string };
      };

      const project = data.cloudaicompanionProject;
      const projectId =
        typeof project === "string"
          ? project
          : typeof project === "object" && project?.id
            ? project.id
            : null;

      if (projectId) {
        cachedAntigravityProject = projectId;
        return projectId;
      }
    } catch {
      // Try next endpoint
    }
  }

  // Use default fallback
  cachedAntigravityProject = DEFAULT_ANTIGRAVITY_PROJECT;
  return DEFAULT_ANTIGRAVITY_PROJECT;
}

export function buildAntigravityHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": `antigravity/1.18.3 ${process.platform}/${process.arch}`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: process.platform === "darwin" ? "MACOS" : "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };
}

export function buildAntigravityBody(
  prompt: string,
  project: string,
  model: string
): object {
  return {
    project,
    model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${randomBytes(16).toString("hex")}`,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {},
    },
  };
}

// --- Codex Constants & Helpers ---

export const CODEX_API_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";

interface CodexJwtClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

export function extractCodexAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;

    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    const claims = JSON.parse(payload) as CodexJwtClaims;

    // Priority 1: root-level chatgpt_account_id
    if (claims.chatgpt_account_id) return claims.chatgpt_account_id;

    // Priority 2: nested under api.openai.com/auth
    const nested = claims["https://api.openai.com/auth"];
    if (nested?.chatgpt_account_id) return nested.chatgpt_account_id;

    // Priority 3: first organization ID
    if (claims.organizations?.[0]?.id) return claims.organizations[0].id;

    return null;
  } catch {
    return null;
  }
}

export function buildCodexHeaders(
  token: string,
  accountId: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  return headers;
}

export function buildCodexBody(prompt: string, model: string): object {
  return {
    model,
    instructions: prompt,
    store: false,
    reasoning: { effort: "medium" },
    text: { verbosity: "low" },
  };
}

// --- Login provider mapping (user-facing name → internal OAuth config ID) ---

export const LOGIN_PROVIDER_MAP: Record<string, string> = {
  google: "google",
  "google-antigravity": "google_antigravity",
  openai: "openai_codex",
};
