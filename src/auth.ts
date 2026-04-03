import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

import {
  type ProviderOAuthConfig,
  PROVIDER_OAUTH_CONFIGS,
  PROVIDER_AUTH_SUPPORT,
} from "./oauth-configs.js";
import { resilientFetch } from "./fetch.js";

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

// --- HTML safety ---

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- OAuth flow (two-phase: start + await callback) ---

export interface PendingOAuthFlow {
  providerId: string;
  authorizationUrl: string;
  callbackPromise: Promise<OAuthCredentials>;
  cancel: () => void;
  // Exposed for manual completion (Docker/SSH fallback)
  state: string;
  codeVerifier?: string;
  config: ProviderOAuthConfig;
  redirectUri: string;
}

// Track the active OAuth flow so the callback tool can await it
let activePendingFlow: PendingOAuthFlow | null = null;

export function getActivePendingFlow(): PendingOAuthFlow | null {
  return activePendingFlow;
}

export function clearActivePendingFlow(): void {
  if (activePendingFlow) {
    activePendingFlow.cancel();
    activePendingFlow = null;
  }
}

/**
 * Phase 1: Start the OAuth flow — returns the auth URL immediately.
 * The callback server runs in the background; use awaitOAuthCallback() to wait for it.
 */
export function startOAuthLogin(
  providerId: string,
  config: ProviderOAuthConfig
): PendingOAuthFlow {
  // Cancel any existing flow
  clearActivePendingFlow();

  const state = generateState();
  const codeVerifier = config.usePkce ? generateCodeVerifier() : undefined;
  const codeChallenge = codeVerifier
    ? generateCodeChallenge(codeVerifier)
    : undefined;

  const hostname = config.callbackHostname ?? "127.0.0.1";
  const callbackPath = config.callbackPath ?? "/callback";
  const redirectUri = `http://${hostname}:${config.callbackPort}${callbackPath}`;

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

  // Append provider-specific extra params (access_type, prompt, etc.)
  if (config.extraAuthParams) {
    for (const [key, value] of Object.entries(config.extraAuthParams)) {
      params.set(key, value);
    }
  }

  const authorizationUrl = `${config.authUrl}?${params.toString()}`;

  // Best-effort browser open (may fail silently in MCP context — that's fine,
  // the URL is returned in the tool response for the agent to show the user)
  try {
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    exec(`${openCmd} "${authorizationUrl}"`);
  } catch {
    // Browser open failed — URL will be shown via tool response
  }

  // Start callback server in the background (5-minute timeout)
  let cancelFn: () => void = () => {};

  const callbackPromise = new Promise<OAuthCredentials>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://${hostname}:${config.callbackPort}`
      );

      // Only handle requests to the configured callback path
      if (url.pathname !== callbackPath) return;

      const code = url.searchParams.get("code");
      const callbackState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authentication failed</h2><p>${escapeHtml(error)}</p><p>You can close this tab.</p></body></html>`
        );
        server.close();
        reject(new Error(`OAuth error from provider: ${error}`));
        return;
      }

      if (code && callbackState) {
        if (callbackState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h2>Authentication failed</h2><p>State mismatch — possible CSRF attack. Please try again.</p></body></html>`
          );
          server.close();
          reject(new Error("OAuth state mismatch — possible CSRF attack"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authenticated!</h2><p>You can close this tab and return to your terminal.</p></body></html>`
        );
        server.close();

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
        if (config.clientSecret) {
          tokenParams.set("client_secret", config.clientSecret);
        }

        resilientFetch(config.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        }, { maxRetries: 1 })
          .then(async (tokenRes) => {
            if (!tokenRes.ok) {
              const body = await tokenRes.text();
              throw new Error(
                `Token exchange failed (${tokenRes.status}): ${body}`
              );
            }
            return tokenRes.json() as Promise<{
              access_token: string;
              refresh_token?: string;
              expires_in?: number;
            }>;
          })
          .then((tokenData) => {
            resolve({
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token,
              expiresAt: tokenData.expires_in
                ? Date.now() + tokenData.expires_in * 1000
                : undefined,
            });
          })
          .catch(reject);
      }
    });

    server.listen(config.callbackPort, hostname);
    server.on("error", (err) => {
      reject(
        new Error(
          `Callback server failed to start on port ${config.callbackPort}: ${err.message}`
        )
      );
    });

    // 5-minute timeout (more generous than 2 min — user needs time to see URL and act)
    const timeout = setTimeout(() => {
      server.close();
      reject(
        new Error(
          "OAuth callback timed out after 5 minutes. The user may not have completed the browser authorization. " +
            "Try again with brainstew_login."
        )
      );
    }, 300_000);

    cancelFn = () => {
      clearTimeout(timeout);
      server.close();
    };
  });

  const flow: PendingOAuthFlow = {
    providerId,
    authorizationUrl,
    callbackPromise,
    cancel: cancelFn,
    state,
    codeVerifier,
    config,
    redirectUri,
  };

  activePendingFlow = flow;
  return flow;
}

/**
 * Phase 2: Await the callback from the browser and store credentials.
 */
export async function awaitOAuthCallback(): Promise<OAuthCredentials> {
  const flow = activePendingFlow;
  if (!flow) {
    throw new Error("No OAuth flow in progress. Call brainstew_login first.");
  }

  try {
    const credentials = await flow.callbackPromise;
    const store = await loadAuthStore();
    store[flow.providerId] = { type: "oauth", oauth: credentials };
    await saveAuthStore(store);
    activePendingFlow = null;
    return credentials;
  } catch (err) {
    activePendingFlow = null;
    throw err;
  }
}

/**
 * Manual OAuth completion fallback for environments where the localhost
 * callback can't receive the redirect (Docker, SSH, Safari HTTPS-Only).
 * The user pastes the full redirect URL from their browser's address bar.
 */
export async function completeOAuthManually(
  callbackUrl: string
): Promise<OAuthCredentials> {
  const flow = activePendingFlow;
  if (!flow) {
    throw new Error("No OAuth flow in progress. Call brainstew_login first.");
  }

  // Cancel the callback server — we're completing manually
  flow.cancel();

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    activePendingFlow = null;
    throw new Error(
      "Invalid URL. Paste the full URL from the browser's address bar (it starts with http://localhost...)."
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    activePendingFlow = null;
    throw new Error(`OAuth error from provider: ${error}`);
  }

  if (!code) {
    activePendingFlow = null;
    throw new Error(
      "No authorization code found in the URL. Make sure you copied the full redirect URL after completing authorization."
    );
  }

  if (returnedState !== flow.state) {
    activePendingFlow = null;
    throw new Error("OAuth state mismatch — possible CSRF attack. Try brainstew_login again.");
  }

  // Exchange code for tokens
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.config.clientId,
  });
  if (flow.codeVerifier) {
    tokenParams.set("code_verifier", flow.codeVerifier);
  }
  if (flow.config.clientSecret) {
    tokenParams.set("client_secret", flow.config.clientSecret);
  }

  const tokenRes = await resilientFetch(flow.config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  }, { maxRetries: 1 });

  if (!tokenRes.ok) {
    const body = (await tokenRes.text()).slice(0, 500);
    activePendingFlow = null;
    throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const credentials: OAuthCredentials = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : undefined,
  };

  const store = await loadAuthStore();
  store[flow.providerId] = { type: "oauth", oauth: credentials };
  await saveAuthStore(store);
  activePendingFlow = null;
  return credentials;
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

  if (config.clientSecret) {
    params.set("client_secret", config.clientSecret);
  }

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

// Proactive refresh buffer: refresh tokens 5 minutes before expiry
const REFRESH_BUFFER_MS = 300_000;

/**
 * Resolve credentials for a logical provider ("google", "openai", "xai").
 * Tries subscription OAuth configs first (in priority order), then standard OAuth,
 * then stored API key, then env var API key.
 *
 * Returns { token, type, oauthProviderId } — oauthProviderId tells callers
 * which specific OAuth config was used (e.g., "google_antigravity" vs "google").
 */
export async function resolveCredentials(
  logicalProvider: string,
  envApiKey?: string
): Promise<{
  token: string;
  type: "oauth" | "apikey";
  oauthProviderId?: string;
}> {
  const support = PROVIDER_AUTH_SUPPORT[logicalProvider];
  const store = await loadAuthStore();

  // Try each OAuth config in priority order
  for (const oauthId of support?.oauthProviderIds ?? []) {
    const config = PROVIDER_OAUTH_CONFIGS[oauthId];
    const creds = store[oauthId];
    if (!config || !creds?.oauth?.accessToken) continue;

    const isExpired =
      creds.oauth.expiresAt &&
      Date.now() > creds.oauth.expiresAt - REFRESH_BUFFER_MS;

    if (isExpired && creds.oauth.refreshToken) {
      try {
        const refreshed = await refreshOAuthToken(config, creds.oauth);
        store[oauthId] = { type: "oauth", oauth: refreshed };
        await saveAuthStore(store);
        return {
          token: refreshed.accessToken,
          type: "oauth",
          oauthProviderId: oauthId,
        };
      } catch {
        // This OAuth config's refresh failed — try next config
        console.error(
          `[brainstew] OAuth refresh failed for ${oauthId}, trying next credential`
        );
        continue;
      }
    } else if (!isExpired) {
      return {
        token: creds.oauth.accessToken,
        type: "oauth",
        oauthProviderId: oauthId,
      };
    }
  }

  // Stored API key (keyed by logical provider name)
  const creds = store[logicalProvider];
  if (creds?.type === "apikey" && creds.apiKey) {
    return { token: creds.apiKey, type: "apikey" };
  }

  // Environment variable API key (fallback)
  if (envApiKey) {
    return { token: envApiKey, type: "apikey" };
  }

  const hint = support
    ? support.oauthProviderIds.length > 0
      ? `Use brainstew_login to authenticate via OAuth, or set ${support.envVar} env var.`
      : `Set the ${support.envVar} env var (get a key at ${support.keyUrl}). This provider does not support OAuth.`
    : `Set the API key env var for this provider.`;

  throw new Error(
    `No credentials for ${logicalProvider}. ${hint} Run brainstew_setup for guided configuration.`
  );
}
