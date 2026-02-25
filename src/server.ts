import express from "express";
import session from "express-session";
import path from "node:path";
import crypto from "node:crypto";
import { Context } from "@osaas/client-core";
import { Configure, Log } from "@osaas/logging";
import helmet from "helmet";
import compression from "compression";
import {
  registerClient,
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
} from "./auth.js";

Configure({ component: "open-media-management" });
const log = Log();

const PAID_PLANS = [
  "PERSONAL",
  "PROFESSIONAL",
  "PRO",
  "ENTERPRISE",
  "BUSINESS",
];
const MAM_FUNCTIONAL_PLANS = [
  "PROFESSIONAL",
  "PRO",
  "ENTERPRISE",
  "BUSINESS",
];

declare module "express-session" {
  interface SessionData {
    codeVerifier?: string;
    state?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiry?: number;
    clientId?: string;
    clientSecret?: string;
    userPlan?: string;
  }
}

const app = express();
const PORT = parseInt(process.env.PORT || "8080", 10);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        connectSrc: ["'self'", "https://app.osaas.io", "https://*.osaas.io"],
      },
    },
  }),
);
app.use(compression());
app.use(express.json({ limit: "1mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

// --- Static files ---
app.use(express.static(path.join(import.meta.dirname, "public")));

// --- Analytics injection ---
const UMAMI_URL = process.env.UMAMI_URL;
const UMAMI_SITE_ID = process.env.UMAMI_SITE_ID;

// --- Auth routes ---

app.get("/auth/signin", async (req, res) => {
  try {
    const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const redirectUri = `${baseUrl}/auth/callback`;

    if (!req.session.clientId) {
      const client = await registerClient(redirectUri);
      req.session.clientId = client.client_id;
      req.session.clientSecret = client.client_secret;
    }

    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = generateState();

    req.session.codeVerifier = codeVerifier;
    req.session.state = state;

    const authUrl = await buildAuthorizationUrl(
      req.session.clientId,
      redirectUri,
      codeChallenge,
      state,
    );

    res.redirect(authUrl);
  } catch (err) {
    log.error("Sign-in error:", err);
    res.redirect("/?error=signin_failed");
  }
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state || state !== req.session.state) {
      return res.redirect("/?error=invalid_callback");
    }

    const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const redirectUri = `${baseUrl}/auth/callback`;

    const tokens = await exchangeCode(
      code as string,
      req.session.codeVerifier!,
      req.session.clientId!,
      req.session.clientSecret,
      redirectUri,
    );

    req.session.accessToken = tokens.access_token;
    req.session.refreshToken = tokens.refresh_token;
    req.session.tokenExpiry = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined;

    delete req.session.codeVerifier;
    delete req.session.state;

    // Fetch user plan
    try {
      const ctx = new Context({ personalAccessToken: tokens.access_token });
      const me = await ctx.getMe();
      req.session.userPlan = (me as Record<string, string>).currentPlan || "FREE";
    } catch {
      req.session.userPlan = "FREE";
    }

    res.redirect("/");
  } catch (err) {
    log.error("Callback error:", err);
    res.redirect("/?error=callback_failed");
  }
});

app.get("/auth/status", (req, res) => {
  const loggedIn = !!req.session.accessToken;
  res.json({
    ok: true,
    loggedIn,
    plan: loggedIn ? req.session.userPlan || "FREE" : null,
    isPaid: loggedIn ? PAID_PLANS.includes(req.session.userPlan || "") : false,
    isFunctional: loggedIn
      ? MAM_FUNCTIONAL_PLANS.includes(req.session.userPlan || "")
      : false,
  });
});

app.get("/auth/signout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// --- API middleware ---

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!req.session.accessToken) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

function requireFunctionalPlan(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!MAM_FUNCTIONAL_PLANS.includes(req.session.userPlan || "")) {
    res.status(403).json({
      error: "Upgrade to PROFESSIONAL plan required",
      upgradeUrl: "https://app.osaas.io",
    });
    return;
  }
  next();
}

async function ensureValidToken(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (
    req.session.tokenExpiry &&
    Date.now() > req.session.tokenExpiry - 60_000
  ) {
    try {
      const tokens = await refreshAccessToken(
        req.session.refreshToken!,
        req.session.clientId!,
        req.session.clientSecret,
      );
      req.session.accessToken = tokens.access_token;
      req.session.refreshToken = tokens.refresh_token || req.session.refreshToken;
      req.session.tokenExpiry = tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined;
    } catch (err) {
      log.error("Token refresh failed:", err);
    }
  }
  next();
}

// --- API routes (stubs for MVP) ---

app.get(
  "/api/assets",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: List assets from metadata store
    res.json({ ok: true, assets: [], total: 0 });
  },
);

app.get(
  "/api/assets/:id",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: Get single asset with metadata
    res.json({ ok: true, asset: null });
  },
);

app.post(
  "/api/assets/upload-url",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: Generate presigned upload URL for MinIO
    res.json({ ok: true, uploadUrl: null, assetId: null });
  },
);

app.put(
  "/api/assets/:id/metadata",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: Update asset metadata
    res.json({ ok: true });
  },
);

app.delete(
  "/api/assets/:id",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: Delete asset (original, proxy, thumbnail, metadata)
    res.json({ ok: true });
  },
);

app.get(
  "/api/collections",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: List collections
    res.json({ ok: true, collections: [] });
  },
);

app.post(
  "/api/collections",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: Create collection
    res.json({ ok: true, collection: null });
  },
);

app.get(
  "/api/storage/status",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: Get storage usage info from MinIO
    res.json({ ok: true, storage: { used: 0, assetCount: 0 } });
  },
);

app.get(
  "/api/search",
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  async (_req, res) => {
    // TODO: Search assets across metadata
    res.json({ ok: true, results: [], total: 0 });
  },
);

// --- SPA fallback ---
app.get("*", (_req, res) => {
  res.sendFile(path.join(import.meta.dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  log.info(`Open Media Management running on port ${PORT}`);
});
