import crypto from "node:crypto";

const OSC_ISSUER = "https://app.osaas.io";
const WELL_KNOWN_PATH = "/.well-known/oauth-authorization-server";

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported?: string[];
}

interface ClientRegistration {
  client_id: string;
  client_secret?: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

let cachedMetadata: OAuthMetadata | null = null;

export async function discoverMetadata(): Promise<OAuthMetadata> {
  if (cachedMetadata) return cachedMetadata;

  const url = `${OSC_ISSUER}${WELL_KNOWN_PATH}`;
  const res = await fetch(url);
  if (!res.ok) {
    cachedMetadata = {
      authorization_endpoint: `${OSC_ISSUER}/api/connect/authorize`,
      token_endpoint: `${OSC_ISSUER}/api/connect/token`,
      registration_endpoint: `${OSC_ISSUER}/api/connect/register`,
    };
    return cachedMetadata;
  }
  cachedMetadata = (await res.json()) as OAuthMetadata;
  return cachedMetadata;
}

export async function registerClient(
  redirectUri: string,
  clientName: string = "Open Media Management",
): Promise<ClientRegistration> {
  const metadata = await discoverMetadata();

  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };

  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client registration failed (${res.status}): ${text}`);
  }

  return (await res.json()) as ClientRegistration;
}

export function generatePKCE(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export async function buildAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
): Promise<string> {
  const metadata = await discoverMetadata();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
): Promise<TokenResponse> {
  const metadata = await discoverMetadata();

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  };

  if (clientSecret) {
    body.client_secret = clientSecret;
  }

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string | undefined,
): Promise<TokenResponse> {
  const metadata = await discoverMetadata();

  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  };

  if (clientSecret) {
    body.client_secret = clientSecret;
  }

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}
