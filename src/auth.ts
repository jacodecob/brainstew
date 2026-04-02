import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

// --- Types ---

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
}

export interface StoredCredentials {
  type: "oauth" | "apikey";
  oauth?: OAuthCredentials;
  apiKey?: string;
}

export interface AuthStore {
  [providerId: string]: StoredCredentials;
}

export interface ProviderOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  callbackPort: number;
  // Some providers use PKCE
  usePkce: boolean;
}

// --- Credential storage (keychain-first, file fallback) ---

const KEYCHAIN_SERVICE = "brainstew-mcp";
const KEYCHAIN_ACCOUNT = "auth-store";
const AUTH_DIR = join(homedir(), ".brainstew");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

let keychainAvailable: boolean | null = null;

async function getKeyring(): Promise<typeof import("@napi-rs/keyring") | null> {
  if (keychainAvailable === false) return null;
  try {
    const keyring = await import("@napi-rs/keyring");
    keychainAvailable = true;
    return keyring;
  } catch {
    keychainAvailable = false;
    console.error(
      "[brainstew] OS keychain unavailable — falling back to file-based credential storage"
    );
    return null;
  }
}

// File-based fallback (used when keychain is unavailable)
async function loadFromFile(): Promise<AuthStore> {
  try {
    const data = await readFile(AUTH_FILE, "utf-8");
    return JSON.parse(data) as AuthStore;
  } catch {
    return {};
  }
}

async function saveToFile(store: AuthStore): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await writeFile(AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export async function loadAuthStore(): Promise<AuthStore> {
  const keyring = await getKeyring();
  if (keyring) {
    try {
      const entry = new keyring.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      const data = entry.getPassword();
      if (!data) throw new Error("No keychain entry");
      return JSON.parse(data) as AuthStore;
    } catch {
      // No keychain entry yet — check file for migration
      const fileStore = await loadFromFile();
      if (Object.keys(fileStore).length > 0) {
        // Migrate existing file credentials to keychain
        await saveAuthStore(fileStore);
        console.error(
          "[brainstew] Migrated credentials from file to OS keychain"
        );
      }
      return fileStore;
    }
  }
  return loadFromFile();
}

export async function saveAuthStore(store: AuthStore): Promise<void> {
  const keyring = await getKeyring();
  if (keyring) {
    try {
      const entry = new keyring.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      entry.setPassword(JSON.stringify(store));
      return;
    } catch (err) {
      console.error(
        `[brainstew] Keychain write failed, falling back to file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  await saveToFile(store);
}

// --- PKCE helpers ---

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// --- Local callback server ---

function startCallbackServer(
  port: number
): Promise<{ code: string; state: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authentication failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`
        );
        reject(new Error(`OAuth error: ${error}`));
        server.close();
        return;
      }

      if (code && state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authenticated!</h2><p>You can close this tab and return to your terminal.</p></body></html>`
        );
        resolve({ code, state, server });
      }
    });

    server.listen(port, "127.0.0.1");
    server.on("error", reject);

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 2 minutes"));
    }, 120_000);
  });
}

// --- OAuth flow ---

export async function performOAuthLogin(
  providerId: string,
  config: ProviderOAuthConfig
): Promise<OAuthCredentials> {
  const state = generateState();
  const codeVerifier = config.usePkce ? generateCodeVerifier() : undefined;
  const codeChallenge = codeVerifier
    ? generateCodeChallenge(codeVerifier)
    : undefined;

  const redirectUri = `http://127.0.0.1:${config.callbackPort}/callback`;

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
  });

  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }

  // Google requires access_type=offline to issue refresh tokens
  if (providerId === "google") {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }

  const authorizationUrl = `${config.authUrl}?${params.toString()}`;

  // Attempt to open browser automatically (best practice for CLI OAuth)
  // Falls back to logging the URL if browser launch fails
  console.error(
    `[brainstew] OAuth login for ${providerId}: opening browser...`
  );
  try {
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    exec(`${openCmd} "${authorizationUrl}"`);
  } catch {
    // Browser launch failed — user will need to open manually
  }
  console.error(`[brainstew] If browser didn't open, visit:\n${authorizationUrl}`);

  // Start callback server and wait
  const { code, state: returnedState, server } = await startCallbackServer(
    config.callbackPort
  );
  server.close();

  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  // Exchange code for tokens
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
  });

  if (codeVerifier) {
    tokenParams.set("code_verifier", codeVerifier);
  }

  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : undefined,
  };
}

// --- Token refresh ---

export async function refreshOAuthToken(
  config: ProviderOAuthConfig,
  credentials: OAuthCredentials
): Promise<OAuthCredentials> {
  if (!credentials.refreshToken) {
    throw new Error("No refresh token available — re-authentication required");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    client_id: config.clientId,
  });

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(
      `Token refresh failed (${res.status}) — re-authentication required`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? credentials.refreshToken,
    expiresAt: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : undefined,
  };
}

// --- Credential resolution ---

export async function getAccessToken(
  providerId: string,
  config: ProviderOAuthConfig,
  envApiKey?: string
): Promise<{ token: string; type: "oauth" | "apikey" }> {
  // Priority 1: Stored OAuth tokens (preferred — most secure, auto-refreshable)
  const store = await loadAuthStore();
  const creds = store[providerId];

  if (creds?.type === "oauth" && creds.oauth?.accessToken) {
    // Check expiry with 60s buffer
    const isExpired =
      creds.oauth.expiresAt && Date.now() > creds.oauth.expiresAt - 60_000;

    if (isExpired && creds.oauth.refreshToken) {
      try {
        const refreshed = await refreshOAuthToken(config, creds.oauth);
        store[providerId] = { type: "oauth", oauth: refreshed };
        await saveAuthStore(store);
        return { token: refreshed.accessToken, type: "oauth" };
      } catch {
        // OAuth refresh failed — fall through to API key fallback
        console.error(
          `[brainstew] OAuth refresh failed for ${providerId}, falling back to API key`
        );
      }
    } else if (!isExpired) {
      return { token: creds.oauth.accessToken, type: "oauth" };
    }
  }

  // Priority 2: Stored API key
  if (creds?.type === "apikey" && creds.apiKey) {
    return { token: creds.apiKey, type: "apikey" };
  }

  // Priority 3: Environment variable API key (fallback)
  if (envApiKey) {
    return { token: envApiKey, type: "apikey" };
  }

  const support = PROVIDER_AUTH_SUPPORT[providerId];
  const hint = support
    ? support.oauth
      ? `Use brainstew_login to authenticate via OAuth, or set ${support.envVar} env var.`
      : `Set the ${support.envVar} env var (get a key at ${support.keyUrl}). This provider does not support OAuth.`
    : `Set the API key env var for this provider.`;

  throw new Error(
    `No credentials for ${providerId}. ${hint} Run brainstew_setup for guided configuration.`
  );
}

// --- Provider OAuth configs ---
// Only providers that genuinely support OAuth for API access are listed here.
// OpenAI Chat Completions API does NOT support OAuth — API key only.
// xAI does NOT support OAuth — API key only.

export const PROVIDER_OAUTH_CONFIGS: Record<string, ProviderOAuthConfig> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    callbackPort: 1456,
    usePkce: true,
  },
};

// Which providers support which auth methods
export const PROVIDER_AUTH_SUPPORT: Record<
  string,
  { oauth: boolean; apiKey: boolean; envVar: string; name: string; keyUrl: string }
> = {
  openai: {
    oauth: false,
    apiKey: true,
    envVar: "OPENAI_API_KEY",
    name: "OpenAI (GPT)",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    oauth: true,
    apiKey: true,
    envVar: "GEMINI_API_KEY",
    name: "Google (Gemini)",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  xai: {
    oauth: false,
    apiKey: true,
    envVar: "XAI_API_KEY",
    name: "xAI (Grok)",
    keyUrl: "https://console.x.ai",
  },
};
