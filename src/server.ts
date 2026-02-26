import express from "express";
import session from "express-session";
import path from "node:path";
import crypto from "node:crypto";
import { Context } from "@osaas/client-core";
import { Configure, Log } from "@osaas/logging";
import helmet from "helmet";
import compression from "compression";
import { Redis } from "ioredis";
import { S3Client } from "@aws-sdk/client-s3";
import {
  registerClient,
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
} from "./auth.js";
import {
  createOscContext,
  ensureMinioInstance,
  ensureValkeyInstance,
  createFfmpegJob,
  waitForFfmpegJob,
  removeFfmpegJob,
  generateFfmpegJobName,
} from "./lib/osc.js";
import type { MinioCredentials } from "./lib/osc.js";
import {
  createS3Client,
  ensureBucket,
  getUploadUrl,
  getDownloadUrl,
  deleteAssetObjects,
  getStorageInfo,
  getS3Uri,
} from "./lib/storage.js";
import {
  createAsset,
  getAsset,
  updateAsset,
  deleteAsset,
  listAssets,
  searchAssets,
  createCollection,
  getCollection,
  updateCollection,
  deleteCollection,
  listCollections,
  addAssetToCollection,
  removeAssetFromCollection,
  getAllTags,
} from "./lib/metadata.js";
import type { Asset } from "./lib/metadata.js";

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

// ---------------------------------------------------------------------------
// Session type extensions
// ---------------------------------------------------------------------------

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
    minioCreds?: {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
      consoleUrl: string;
    };
    valkeyUrl?: string;
    servicesReady?: boolean;
  }
}

// ---------------------------------------------------------------------------
// In-memory client caches (keyed per user connection)
// ---------------------------------------------------------------------------

const redisClients = new Map<string, Redis>();
const s3Clients = new Map<string, S3Client>();

function getRedis(valkeyUrl: string): Redis {
  if (!redisClients.has(valkeyUrl)) {
    redisClients.set(valkeyUrl, new Redis(valkeyUrl));
  }
  return redisClients.get(valkeyUrl)!;
}

function getS3(creds: MinioCredentials): S3Client {
  const key = creds.endpoint;
  if (!s3Clients.has(key)) {
    s3Clients.set(key, createS3Client(creds));
  }
  return s3Clients.get(key)!;
}

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = parseInt(process.env.PORT || "8080", 10);

// Trust proxy so X-Forwarded-Proto/Host headers are respected
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        connectSrc: [
          "'self'",
          "https://app.osaas.io",
          "https://*.osaas.io",
          "https://*.auto.prod.osaas.io",
          "https://mediamanagement.apps.osaas.io",
        ],
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
      secure: true,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  }),
);

// --- Static files ---
app.use(express.static(path.join(import.meta.dirname, "public")));

// --- Analytics injection ---
const UMAMI_URL = process.env.UMAMI_URL;
const UMAMI_SITE_ID = process.env.UMAMI_SITE_ID;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the public-facing base URL from the incoming request.
 *
 * When behind a reverse proxy (OSC / nginx) the original protocol and host
 * are forwarded via X-Forwarded-Proto and X-Forwarded-Host headers.
 * This ensures OAuth redirect URIs always match the domain the user is
 * actually visiting, regardless of which internal URL OSC sets in APP_URL.
 */
function getBaseUrl(req: express.Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host =
    (req.headers["x-forwarded-host"] as string) || req.get("host") || "localhost";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.get("/auth/signin", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
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

    const baseUrl = getBaseUrl(req);
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
      const planResponse = await fetch("https://money.svc.prod.osaas.io/mytenantplan", {
        headers: { "x-pat-jwt": `Bearer ${tokens.access_token}` },
      });
      if (planResponse.ok) {
        const plan = (await planResponse.json()) as Record<string, string>;
        req.session.userPlan = plan.name || "FREE";
      } else {
        req.session.userPlan = "FREE";
      }
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

// ---------------------------------------------------------------------------
// API middleware
// ---------------------------------------------------------------------------

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

/**
 * Middleware that provisions MinIO + Valkey instances on the user's OSC account
 * on first API call after login. Credentials are stored in the session and
 * S3/Redis clients are cached in memory.
 */
async function ensureUserServices(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (req.session.servicesReady) {
    next();
    return;
  }

  try {
    const ctx = createOscContext(req.session.accessToken!);

    // Provision MinIO instance
    log.info("Provisioning MinIO instance for user...");
    const minioCreds = await ensureMinioInstance(ctx, "mamstorage");
    req.session.minioCreds = {
      endpoint: minioCreds.endpoint,
      accessKeyId: minioCreds.accessKeyId,
      secretAccessKey: minioCreds.secretAccessKey,
      consoleUrl: minioCreds.consoleUrl,
    };

    // Provision Valkey instance
    log.info("Provisioning Valkey instance for user...");
    const valkeyConn = await ensureValkeyInstance(ctx, "mamcache");
    req.session.valkeyUrl = valkeyConn.url;

    // Ensure the media-assets bucket exists
    log.info("Ensuring media-assets bucket exists...");
    const s3 = getS3(minioCreds);
    await ensureBucket(s3);

    req.session.servicesReady = true;
    log.info("User services provisioned successfully");
    next();
  } catch (err) {
    log.error("Failed to provision user services:", err);
    res.status(503).json({
      error: "Failed to provision storage services. Please try again shortly.",
    });
  }
}

// ---------------------------------------------------------------------------
// Proxy generation (async, fire-and-forget)
// ---------------------------------------------------------------------------

async function triggerProxyGeneration(
  ctx: Context,
  redis: Redis,
  minioCreds: MinioCredentials,
  asset: Asset,
): Promise<void> {
  // Only for video files
  if (!asset.mimeType.startsWith("video/")) {
    // For non-video, just mark as "none"
    await updateAsset(redis, asset.id, { proxyStatus: "none" });
    return;
  }

  try {
    await updateAsset(redis, asset.id, { proxyStatus: "processing" });

    const inputUri = getS3Uri(asset.id, "original", asset.filename);
    const proxyUri = getS3Uri(asset.id, "proxy");
    const thumbUri = getS3Uri(asset.id, "thumbnail");

    // Generate proxy (lower-bitrate MP4)
    const proxyJobName = generateFfmpegJobName("proxy");
    const proxyCmdArgs = `-i ${inputUri} -vf scale=1280:-2 -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k -movflags +faststart ${proxyUri}`;

    await createFfmpegJob(ctx, proxyJobName, proxyCmdArgs, minioCreds);
    const proxyStatus = await waitForFfmpegJob(ctx, proxyJobName);
    await removeFfmpegJob(ctx, proxyJobName);

    if (proxyStatus !== "Complete") {
      log.error(`Proxy generation failed for asset ${asset.id}: ${proxyStatus}`);
      await updateAsset(redis, asset.id, { proxyStatus: "failed" });
      return;
    }

    // Generate thumbnail
    const thumbJobName = generateFfmpegJobName("thumb");
    const thumbCmdArgs = `-i ${inputUri} -vf "thumbnail,scale=320:-2" -frames:v 1 ${thumbUri}`;

    await createFfmpegJob(ctx, thumbJobName, thumbCmdArgs, minioCreds);
    const thumbStatus = await waitForFfmpegJob(ctx, thumbJobName);
    await removeFfmpegJob(ctx, thumbJobName);

    // Update asset with proxy/thumbnail keys
    const updates: Partial<Asset> = {
      proxyKey: `proxies/${asset.id}/proxy.mp4`,
      proxyStatus: "ready",
    };

    if (thumbStatus === "Complete") {
      updates.thumbnailKey = `thumbnails/${asset.id}/thumb.jpg`;
    }

    await updateAsset(redis, asset.id, updates);
    log.info(`Proxy generation complete for asset ${asset.id}`);
  } catch (err) {
    log.error(`Proxy generation error for asset ${asset.id}:`, err);
    await updateAsset(redis, asset.id, { proxyStatus: "failed" }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Demo routes (authenticated but no functional plan required)
// ---------------------------------------------------------------------------

app.get("/api/demo/assets", requireAuth, (_req, res) => {
  const demoAssets = [
    {
      id: "demo-1",
      title: "Big Buck Bunny",
      filename: "big_buck_bunny.mp4",
      mimeType: "video/mp4",
      fileSize: 158008374,
      duration: 596,
      resolution: "1920x1080",
      thumbnailUrl: "https://peach.blender.org/wp-content/uploads/bbb-splash.png",
      proxyStatus: "ready",
      tags: ["animation", "demo"],
      collections: [],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "demo-2",
      title: "Sintel",
      filename: "sintel.mp4",
      mimeType: "video/mp4",
      fileSize: 129241752,
      duration: 888,
      resolution: "1920x818",
      thumbnailUrl: "https://durian.blender.org/wp-content/uploads/2010/06/01.jpg",
      proxyStatus: "ready",
      tags: ["animation", "demo"],
      collections: [],
      createdAt: "2024-01-02T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
    },
    {
      id: "demo-3",
      title: "Tears of Steel",
      filename: "tears_of_steel.mp4",
      mimeType: "video/mp4",
      fileSize: 185431982,
      duration: 734,
      resolution: "1920x800",
      thumbnailUrl: "https://mango.blender.org/wp-content/gallery/4kstills/01_thom_702.jpg",
      proxyStatus: "ready",
      tags: ["vfx", "demo"],
      collections: [],
      createdAt: "2024-01-03T00:00:00Z",
      updatedAt: "2024-01-03T00:00:00Z",
    },
    {
      id: "demo-4",
      title: "Spring",
      filename: "spring.mp4",
      mimeType: "video/mp4",
      fileSize: 78994210,
      duration: 464,
      resolution: "3840x2160",
      thumbnailUrl: "https://cloud.blender.org/p/spring/5eb136f4d3dab7296d45d647/thumbnails/0001.png",
      proxyStatus: "ready",
      tags: ["animation", "4k", "demo"],
      collections: [],
      createdAt: "2024-01-04T00:00:00Z",
      updatedAt: "2024-01-04T00:00:00Z",
    },
    {
      id: "demo-5",
      title: "Cosmos Laundromat",
      filename: "cosmos_laundromat.mp4",
      mimeType: "video/mp4",
      fileSize: 92341832,
      duration: 726,
      resolution: "2048x858",
      thumbnailUrl: "https://gooseberry.blender.org/wp-content/uploads/2015/01/frame_00643.jpg",
      proxyStatus: "ready",
      tags: ["animation", "pilot", "demo"],
      collections: [],
      createdAt: "2024-01-05T00:00:00Z",
      updatedAt: "2024-01-05T00:00:00Z",
    },
  ];
  res.json({ ok: true, assets: demoAssets, total: demoAssets.length, demo: true });
});

// ---------------------------------------------------------------------------
// API routes (all require auth + valid token + functional plan + services)
// ---------------------------------------------------------------------------

const apiMiddleware = [
  requireAuth,
  ensureValidToken,
  requireFunctionalPlan,
  ensureUserServices,
] as const;

// --- Assets ---

app.get("/api/assets", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const s3 = getS3(req.session.minioCreds as MinioCredentials);

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const sort = (req.query.sort as string) || "createdAt";
    const order = (req.query.order as string) || "desc";
    const type = req.query.type as string | undefined;
    const collectionId = req.query.collectionId as string | undefined;

    const result = await listAssets(redis, {
      page,
      limit,
      sort: sort as "createdAt" | "title" | "fileSize" | "duration",
      order: order as "asc" | "desc",
      type,
      collectionId,
    });

    // Generate thumbnail URLs for assets that have them
    const assetsWithUrls = await Promise.all(
      result.assets.map(async (asset) => {
        let thumbnailUrl: string | undefined;
        if (asset.thumbnailKey) {
          try {
            thumbnailUrl = await getDownloadUrl(s3, asset.thumbnailKey);
          } catch {
            // Thumbnail URL generation failed, leave undefined
          }
        }
        return { ...asset, thumbnailUrl };
      }),
    );

    res.json({ ok: true, assets: assetsWithUrls, total: result.total });
  } catch (err) {
    log.error("Failed to list assets:", err);
    res.status(500).json({ error: "Failed to list assets" });
  }
});

app.get("/api/assets/:id", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const s3 = getS3(req.session.minioCreds as MinioCredentials);

    const asset = await getAsset(redis, (req.params.id as string));
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    // Generate download URLs for all available keys
    let originalUrl: string | undefined;
    let proxyUrl: string | undefined;
    let thumbnailUrl: string | undefined;
    let posterUrl: string | undefined;

    try {
      if (asset.minioKey) {
        originalUrl = await getDownloadUrl(s3, asset.minioKey);
      }
    } catch {
      // Original URL generation failed
    }

    try {
      if (asset.proxyKey) {
        proxyUrl = await getDownloadUrl(s3, asset.proxyKey);
      }
    } catch {
      // Proxy URL generation failed
    }

    try {
      if (asset.thumbnailKey) {
        thumbnailUrl = await getDownloadUrl(s3, asset.thumbnailKey);
      }
    } catch {
      // Thumbnail URL generation failed
    }

    try {
      if (asset.posterKey) {
        posterUrl = await getDownloadUrl(s3, asset.posterKey);
      }
    } catch {
      // Poster URL generation failed
    }

    res.json({
      ok: true,
      asset: { ...asset, originalUrl, proxyUrl, thumbnailUrl, posterUrl },
    });
  } catch (err) {
    log.error("Failed to get asset:", err);
    res.status(500).json({ error: "Failed to get asset" });
  }
});

app.post("/api/assets/upload-url", ...apiMiddleware, async (req, res) => {
  try {
    const { filename, contentType, fileSize } = req.body;

    if (!filename || !contentType) {
      res.status(400).json({ error: "filename and contentType are required" });
      return;
    }

    if (typeof fileSize === "number" && fileSize <= 0) {
      res.status(400).json({ error: "fileSize must be a positive number" });
      return;
    }

    const s3 = getS3(req.session.minioCreds as MinioCredentials);
    const assetId = crypto.randomUUID();

    const uploadUrl = await getUploadUrl(s3, assetId, filename, contentType);

    res.json({ ok: true, uploadUrl, assetId });
  } catch (err) {
    log.error("Failed to generate upload URL:", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

app.post("/api/assets/confirm-upload", ...apiMiddleware, async (req, res) => {
  try {
    const { assetId, filename, contentType, fileSize, title, description, tags } = req.body;

    if (!assetId || !filename || !contentType) {
      res.status(400).json({ error: "assetId, filename, and contentType are required" });
      return;
    }

    const redis = getRedis(req.session.valkeyUrl!);
    const minioCreds = req.session.minioCreds as MinioCredentials;
    const ctx = createOscContext(req.session.accessToken!);

    const minioKey = `originals/${assetId}/${filename}`;

    const asset = await createAsset(redis, {
      filename,
      mimeType: contentType,
      fileSize: fileSize || 0,
      title: title || filename,
      description: description || "",
      tags: tags || [],
      customMeta: {},
      minioKey,
      proxyStatus: "pending",
      collections: [],
    });

    // Fire-and-forget proxy/thumbnail generation
    triggerProxyGeneration(ctx, redis, minioCreds, asset).catch((err) =>
      log.error(`Background proxy generation failed for asset ${asset.id}:`, err),
    );

    res.json({ ok: true, asset });
  } catch (err) {
    log.error("Failed to confirm upload:", err);
    res.status(500).json({ error: "Failed to confirm upload" });
  }
});

app.put("/api/assets/:id/metadata", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const { title, description, tags, customMeta } = req.body;

    const updates: Partial<Asset> = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (tags !== undefined) updates.tags = tags;
    if (customMeta !== undefined) updates.customMeta = customMeta;

    const asset = await updateAsset(redis, (req.params.id as string), updates);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    res.json({ ok: true, asset });
  } catch (err) {
    log.error("Failed to update asset metadata:", err);
    res.status(500).json({ error: "Failed to update asset metadata" });
  }
});

app.delete("/api/assets/:id", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const s3 = getS3(req.session.minioCreds as MinioCredentials);

    const asset = await getAsset(redis, (req.params.id as string));
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    // Remove metadata from Valkey
    await deleteAsset(redis, (req.params.id as string));

    // Remove files from MinIO
    await deleteAssetObjects(s3, (req.params.id as string));

    res.json({ ok: true });
  } catch (err) {
    log.error("Failed to delete asset:", err);
    res.status(500).json({ error: "Failed to delete asset" });
  }
});

app.get("/api/assets/:id/proxy-status", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);

    const asset = await getAsset(redis, (req.params.id as string));
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    res.json({ ok: true, proxyStatus: asset.proxyStatus });
  } catch (err) {
    log.error("Failed to get proxy status:", err);
    res.status(500).json({ error: "Failed to get proxy status" });
  }
});

// --- Collections ---

app.get("/api/collections", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const collections = await listCollections(redis);
    res.json({ ok: true, collections });
  } catch (err) {
    log.error("Failed to list collections:", err);
    res.status(500).json({ error: "Failed to list collections" });
  }
});

app.post("/api/collections", ...apiMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "Collection name is required" });
      return;
    }

    const redis = getRedis(req.session.valkeyUrl!);
    const collection = await createCollection(redis, name.trim(), description);
    res.json({ ok: true, collection });
  } catch (err) {
    log.error("Failed to create collection:", err);
    res.status(500).json({ error: "Failed to create collection" });
  }
});

app.put("/api/collections/:id", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const { name, description, coverAssetId } = req.body;

    const updates: Partial<{ name: string; description: string; coverAssetId: string }> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (coverAssetId !== undefined) updates.coverAssetId = coverAssetId;

    const collection = await updateCollection(redis, (req.params.id as string), updates);
    if (!collection) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    res.json({ ok: true, collection });
  } catch (err) {
    log.error("Failed to update collection:", err);
    res.status(500).json({ error: "Failed to update collection" });
  }
});

app.delete("/api/collections/:id", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const deleted = await deleteCollection(redis, (req.params.id as string));

    if (!deleted) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    log.error("Failed to delete collection:", err);
    res.status(500).json({ error: "Failed to delete collection" });
  }
});

app.post("/api/collections/:id/assets", ...apiMiddleware, async (req, res) => {
  try {
    const { assetId } = req.body;

    if (!assetId || typeof assetId !== "string") {
      res.status(400).json({ error: "assetId is required" });
      return;
    }

    const redis = getRedis(req.session.valkeyUrl!);
    await addAssetToCollection(redis, (req.params.id as string), assetId);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add asset to collection";
    log.error("Failed to add asset to collection:", err);

    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.delete("/api/collections/:id/assets/:assetId", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    await removeAssetFromCollection(redis, (req.params.id as string), (req.params.assetId as string));
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove asset from collection";
    log.error("Failed to remove asset from collection:", err);

    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

// --- Storage ---

app.get("/api/storage/status", ...apiMiddleware, async (req, res) => {
  try {
    const s3 = getS3(req.session.minioCreds as MinioCredentials);
    const info = await getStorageInfo(s3);
    res.json({ ok: true, storage: info });
  } catch (err) {
    log.error("Failed to get storage status:", err);
    res.status(500).json({ error: "Failed to get storage status" });
  }
});

// --- Search ---

app.get("/api/search", ...apiMiddleware, async (req, res) => {
  try {
    const q = req.query.q as string;

    if (!q || q.trim().length === 0) {
      res.json({ ok: true, assets: [], total: 0 });
      return;
    }

    const redis = getRedis(req.session.valkeyUrl!);
    const s3 = getS3(req.session.minioCreds as MinioCredentials);

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const type = req.query.type as string | undefined;

    const result = await searchAssets(redis, q, { page, limit, type });

    // Generate thumbnail URLs for assets that have them
    const assetsWithUrls = await Promise.all(
      result.assets.map(async (asset) => {
        let thumbnailUrl: string | undefined;
        if (asset.thumbnailKey) {
          try {
            thumbnailUrl = await getDownloadUrl(s3, asset.thumbnailKey);
          } catch {
            // Thumbnail URL generation failed, leave undefined
          }
        }
        return { ...asset, thumbnailUrl };
      }),
    );

    res.json({ ok: true, assets: assetsWithUrls, total: result.total });
  } catch (err) {
    log.error("Failed to search assets:", err);
    res.status(500).json({ error: "Failed to search assets" });
  }
});

// --- Tags ---

app.get("/api/tags", ...apiMiddleware, async (req, res) => {
  try {
    const redis = getRedis(req.session.valkeyUrl!);
    const tags = await getAllTags(redis);
    res.json({ ok: true, tags });
  } catch (err) {
    log.error("Failed to get tags:", err);
    res.status(500).json({ error: "Failed to get tags" });
  }
});

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

app.get("*", (_req, res) => {
  res.sendFile(path.join(import.meta.dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  log.info(`Open Media Management running on port ${PORT}`);
});
