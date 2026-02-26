/**
 * OSC Service Management for Open Media Management
 *
 * Wraps @osaas/client-core to manage MinIO, Valkey, and FFmpeg instances
 * on users' OSC accounts. Provides idempotent "ensure" patterns for
 * persistent services and ephemeral job management for FFmpeg processing.
 *
 * Service IDs:
 * - minio-minio: S3-compatible object storage
 * - valkey-io-valkey: Redis-compatible cache and pub/sub
 * - eyevinn-ffmpeg-s3: Ephemeral FFmpeg job containers
 */

import {
  Context,
  createInstance,
  getInstance,
  listInstances,
  removeInstance,
  waitForInstanceReady,
} from "@osaas/client-core";
import { Log } from "@osaas/logging";

const logger = Log();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINIO_SERVICE_ID = "minio-minio";
const VALKEY_SERVICE_ID = "valkey-io-valkey";
const FFMPEG_SERVICE_ID = "eyevinn-ffmpeg-s3";

/** Base URL for Valkey service API (ports endpoint). */
const VALKEY_API_BASE = "https://api-valkey-io-valkey.auto.prod.osaas.io";

/** Default maximum wait time for FFmpeg jobs (5 minutes). */
const DEFAULT_FFMPEG_MAX_WAIT_MS = 5 * 60 * 1000;

/** Polling interval for FFmpeg job status checks (2 seconds). */
const FFMPEG_POLL_INTERVAL_MS = 2000;

/** Retry settings for instance creation. */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Credentials and endpoints for a MinIO instance.
 * Used to configure S3 clients and FFmpeg jobs.
 */
export interface MinioCredentials {
  /** S3-compatible endpoint URL (e.g. https://mam-storage-1.minio-minio.auto.prod.osaas.io) */
  endpoint: string;
  /** Access key (RootUser) for S3 operations */
  accessKeyId: string;
  /** Secret key (RootPassword) for S3 operations */
  secretAccessKey: string;
  /** MinIO web console URL */
  consoleUrl: string;
}

/**
 * Connection details for a Valkey (Redis-compatible) instance.
 */
export interface ValkeyConnection {
  /** Redis connection string (e.g. redis://:password@host:port) */
  url: string;
}

/**
 * Result from creating or querying an FFmpeg job.
 */
export interface FfmpegJobResult {
  /** Job instance name (lowercase alphanumeric) */
  name: string;
  /** Current job status (e.g. Running, Complete, Failed, Error, Suspended) */
  status: string;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Create an OSC context from the user's access token (PAT).
 *
 * The Context is the entry point for all @osaas/client-core operations.
 * It wraps the user's Personal Access Token and provides methods for
 * obtaining Service Access Tokens.
 *
 * @param accessToken - The user's OAuth access token (PAT) stored in session
 * @returns A configured OSC Context
 */
export function createOscContext(accessToken: string): Context {
  return new Context({ personalAccessToken: accessToken });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retry an async operation with exponential backoff.
 *
 * Used for instance creation and other operations that may transiently fail
 * due to entitlement glitches or eventual consistency.
 *
 * @param fn - The async function to retry
 * @param label - Descriptive label for logging
 * @returns The result of the successful invocation
 * @throws The last error encountered after all retries are exhausted
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn(
        `${label}: attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS} failed, retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a MinIO-compatible password.
 *
 * MinIO requires passwords of at least 8 characters with mixed case and digits.
 * This generates a 24-character password using crypto-safe randomness.
 */
function generatePassword(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let password = "";
  for (const b of bytes) {
    password += chars[b % chars.length];
  }
  return password;
}

// ---------------------------------------------------------------------------
// MinIO Management
// ---------------------------------------------------------------------------

/**
 * Ensure a MinIO instance exists and is ready on the user's OSC account.
 *
 * This follows the idempotent "ensure" pattern: if an instance with the given
 * name already exists, its credentials are returned. Otherwise a new instance
 * is created, waited on until ready, and its credentials are returned.
 *
 * MinIO credentials (RootUser, RootPassword) are auto-generated by OSC if not
 * provided, and are included in the instance response.
 *
 * @param ctx - OSC context with the user's PAT
 * @param name - Instance name (e.g. "mam-storage-1")
 * @returns MinIO credentials and endpoints
 * @throws If instance creation fails after retries or instance never becomes ready
 */
export async function ensureMinioInstance(
  ctx: Context,
  name: string,
): Promise<MinioCredentials> {
  const sat = await ctx.getServiceAccessToken(MINIO_SERVICE_ID);

  // Check for existing instance first (idempotent)
  const existing = await getInstance(ctx, MINIO_SERVICE_ID, name, sat);
  if (existing) {
    logger.info(`MinIO instance "${name}" already exists`);
    return extractMinioCredentials(existing);
  }

  // Create new instance with retry
  logger.info(`Creating MinIO instance "${name}"`);
  const instance = await withRetry(
    () =>
      createInstance(ctx, MINIO_SERVICE_ID, sat, {
        name,
      }),
    `createInstance(${MINIO_SERVICE_ID}, ${name})`,
  );

  // Wait for the instance to become ready (services take time to start)
  logger.info(`Waiting for MinIO instance "${name}" to be ready`);
  await waitForInstanceReady(MINIO_SERVICE_ID, name, ctx);
  logger.info(`MinIO instance "${name}" is ready`);

  return extractMinioCredentials(instance);
}

/**
 * Extract MinIO credentials from an instance response object.
 *
 * The instance response contains:
 * - url: S3 endpoint URL
 * - RootUser: access key
 * - RootPassword: secret key
 * - resources.app.url: web console URL
 */
function extractMinioCredentials(instance: Record<string, unknown>): MinioCredentials {
  const resources = instance.resources as
    | Record<string, { url?: string }>
    | undefined;
  const consoleUrl = resources?.app?.url ?? "";

  return {
    endpoint: instance.url as string,
    accessKeyId: instance.RootUser as string,
    secretAccessKey: instance.RootPassword as string,
    consoleUrl: typeof consoleUrl === "string" ? consoleUrl : "",
  };
}

/**
 * Get the health status of a MinIO instance.
 *
 * Possible statuses: "starting", "running", "stopped", "failed", "unknown".
 *
 * @param ctx - OSC context with the user's PAT
 * @param name - Instance name
 * @returns Health status string
 */
export async function getMinioHealth(
  ctx: Context,
  name: string,
): Promise<string> {
  try {
    const sat = await ctx.getServiceAccessToken(MINIO_SERVICE_ID);
    const instance = await getInstance(ctx, MINIO_SERVICE_ID, name, sat);
    if (!instance) {
      return "unknown";
    }
    // Instance status is available on the instance object
    return (instance.status as string) ?? "unknown";
  } catch (err) {
    logger.error(`Failed to get MinIO health for "${name}": ${err}`);
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Valkey Management
// ---------------------------------------------------------------------------

/**
 * Ensure a Valkey (Redis-compatible) instance exists and is ready.
 *
 * After the instance is created, the external connection details are fetched
 * from the Valkey ports endpoint. The Valkey `url` field does NOT contain the
 * correct external connection info -- the ports endpoint must be called to get
 * the externalIp and externalPort for building the Redis connection string.
 *
 * @param ctx - OSC context with the user's PAT
 * @param name - Instance name (e.g. "mam-cache")
 * @param password - Optional Redis password. If omitted, one is generated.
 * @returns Valkey connection details including the Redis connection URL
 * @throws If instance creation or port lookup fails
 */
export async function ensureValkeyInstance(
  ctx: Context,
  name: string,
  password?: string,
): Promise<ValkeyConnection> {
  const sat = await ctx.getServiceAccessToken(VALKEY_SERVICE_ID);
  const instancePassword = password ?? generatePassword();

  // Check for existing instance first (idempotent)
  const existing = await getInstance(ctx, VALKEY_SERVICE_ID, name, sat);
  if (existing) {
    logger.info(`Valkey instance "${name}" already exists`);
    return buildValkeyConnection(ctx, name, existing.Password as string);
  }

  // Create new instance with retry
  logger.info(`Creating Valkey instance "${name}"`);
  const instance = await withRetry(
    () =>
      createInstance(ctx, VALKEY_SERVICE_ID, sat, {
        name,
        Password: instancePassword,
      }),
    `createInstance(${VALKEY_SERVICE_ID}, ${name})`,
  );

  // Wait for the instance to become ready
  logger.info(`Waiting for Valkey instance "${name}" to be ready`);
  await waitForInstanceReady(VALKEY_SERVICE_ID, name, ctx);
  logger.info(`Valkey instance "${name}" is ready`);

  const pwd = (instance.Password as string) ?? instancePassword;
  return buildValkeyConnection(ctx, name, pwd);
}

/**
 * Build a Valkey Redis connection URL by querying the ports endpoint.
 *
 * The instance's `url` field does NOT contain the correct external connection
 * info. We must call the ports endpoint to obtain externalIp and externalPort.
 *
 * Endpoint: GET https://api-valkey-io-valkey.auto.prod.osaas.io/ports/{name}
 * Auth: Bearer SAT
 *
 * @param ctx - OSC context
 * @param name - Valkey instance name
 * @param password - Redis password
 * @returns ValkeyConnection with the redis:// URL
 */
async function buildValkeyConnection(
  ctx: Context,
  name: string,
  password: string,
): Promise<ValkeyConnection> {
  const sat = await ctx.getServiceAccessToken(VALKEY_SERVICE_ID);
  const portsUrl = `${VALKEY_API_BASE}/ports/${name}`;

  logger.info(`Fetching Valkey connection info from ${portsUrl}`);
  const response = await fetch(portsUrl, {
    headers: {
      Authorization: `Bearer ${sat}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to get Valkey ports for "${name}": ${response.status} ${body}`,
    );
  }

  const portsData = await response.json();

  // The ports endpoint returns an array of port mappings, e.g.:
  // [{ externalIp: "1.2.3.4", externalPort: 10508, internalPort: 6379 }]
  // Extract the first entry (the Redis port).
  const portEntry = Array.isArray(portsData) ? portsData[0] : portsData;
  const externalIp = portEntry?.externalIp as string;
  const externalPort = portEntry?.externalPort as number;

  if (!externalIp || !externalPort) {
    throw new Error(
      `Valkey ports response missing externalIp or externalPort: ${JSON.stringify(portsData)}`,
    );
  }

  const url = `redis://:${encodeURIComponent(password)}@${externalIp}:${externalPort}`;
  logger.info(`Valkey connection established: ${externalIp}:${externalPort}`);

  return { url };
}

// ---------------------------------------------------------------------------
// FFmpeg Job Management
// ---------------------------------------------------------------------------

/**
 * Create an ephemeral FFmpeg-S3 job on the user's OSC account.
 *
 * FFmpeg-S3 jobs are job-type (ephemeral) services: a container is created,
 * runs the FFmpeg command, writes output to S3/MinIO, and exits. The job
 * container should be removed after completion.
 *
 * Instance names MUST be lowercase alphanumeric only -- no hyphens, underscores,
 * or uppercase characters. Names like "thumb1a2b3c" are valid; "thumb-123" is not.
 *
 * @param ctx - OSC context with the user's PAT
 * @param jobName - Lowercase alphanumeric job name (e.g. "thumb1a2b3c4d")
 * @param cmdLineArgs - Full FFmpeg command arguments (supports s3:// URLs)
 * @param minio - MinIO credentials for S3 access within the FFmpeg job
 * @returns Job result with name and initial status
 * @throws If the job name is invalid or creation fails
 */
export async function createFfmpegJob(
  ctx: Context,
  jobName: string,
  cmdLineArgs: string,
  minio: MinioCredentials,
): Promise<FfmpegJobResult> {
  // Validate job name: must be lowercase alphanumeric only
  if (!/^[a-z0-9]+$/.test(jobName)) {
    throw new Error(
      `FFmpeg job name must be lowercase alphanumeric only (got "${jobName}"). ` +
        "No hyphens, underscores, or uppercase characters allowed.",
    );
  }

  const sat = await ctx.getServiceAccessToken(FFMPEG_SERVICE_ID);

  logger.info(`Creating FFmpeg job "${jobName}"`);
  logger.info(`  cmdLineArgs: ${cmdLineArgs}`);

  const instance = await createInstance(ctx, FFMPEG_SERVICE_ID, sat, {
    name: jobName,
    cmdLineArgs,
    awsAccessKeyId: minio.accessKeyId,
    awsSecretAccessKey: minio.secretAccessKey,
    s3EndpointUrl: minio.endpoint,
  });

  const status = (instance.status as string) ?? "Running";
  logger.info(`FFmpeg job "${jobName}" created with status: ${status}`);

  return {
    name: jobName,
    status,
  };
}

/**
 * Get the current status of an FFmpeg job.
 *
 * Possible statuses: "Complete", "Failed", "Error", "Suspended", "Running".
 * Returns "unknown" if the job cannot be found.
 *
 * @param ctx - OSC context with the user's PAT
 * @param jobName - The job name to check
 * @returns Current status string
 */
export async function getFfmpegJobStatus(
  ctx: Context,
  jobName: string,
): Promise<string> {
  try {
    const sat = await ctx.getServiceAccessToken(FFMPEG_SERVICE_ID);
    const instance = await getInstance(ctx, FFMPEG_SERVICE_ID, jobName, sat);
    if (!instance) {
      return "unknown";
    }
    return (instance.status as string) ?? "unknown";
  } catch (err) {
    logger.error(`Failed to get FFmpeg job status for "${jobName}": ${err}`);
    return "unknown";
  }
}

/**
 * Wait for an FFmpeg job to reach a terminal state by polling.
 *
 * Polls every 2 seconds until the job status is "Complete", "Failed", "Error",
 * or the maximum wait time is exceeded. The FFmpeg-S3 service does not support
 * webhooks, so polling is the only option.
 *
 * After this function returns, the caller should clean up the job container
 * using removeInstance or removeJob.
 *
 * @param ctx - OSC context with the user's PAT
 * @param jobName - The job name to poll
 * @param maxWaitMs - Maximum wait time in milliseconds (default: 5 minutes)
 * @returns Final job status ("Complete", "Failed", "Error", or "timeout")
 */
export async function waitForFfmpegJob(
  ctx: Context,
  jobName: string,
  maxWaitMs: number = DEFAULT_FFMPEG_MAX_WAIT_MS,
): Promise<string> {
  const terminalStatuses = new Set(["Complete", "Failed", "Error"]);
  const startTime = Date.now();

  logger.info(
    `Waiting for FFmpeg job "${jobName}" (max ${maxWaitMs / 1000}s)`,
  );

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getFfmpegJobStatus(ctx, jobName);

    if (terminalStatuses.has(status)) {
      logger.info(
        `FFmpeg job "${jobName}" reached terminal status: ${status} ` +
          `(elapsed: ${Math.round((Date.now() - startTime) / 1000)}s)`,
      );
      return status;
    }

    logger.info(
      `FFmpeg job "${jobName}" status: ${status}, ` +
        `elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`,
    );
    await sleep(FFMPEG_POLL_INTERVAL_MS);
  }

  logger.warn(
    `FFmpeg job "${jobName}" timed out after ${maxWaitMs / 1000}s`,
  );
  return "timeout";
}

/**
 * Remove an FFmpeg job container (cleanup after completion).
 *
 * This should be called after a job reaches a terminal status to free
 * resources. Errors are logged but not thrown (best-effort cleanup).
 *
 * @param ctx - OSC context with the user's PAT
 * @param jobName - The job name to remove
 */
export async function removeFfmpegJob(
  ctx: Context,
  jobName: string,
): Promise<void> {
  try {
    const sat = await ctx.getServiceAccessToken(FFMPEG_SERVICE_ID);
    await removeInstance(ctx, FFMPEG_SERVICE_ID, jobName, sat);
    logger.info(`FFmpeg job "${jobName}" removed`);
  } catch (err) {
    logger.warn(`Failed to remove FFmpeg job "${jobName}": ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Service Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove a service instance by service ID and name.
 *
 * Generic cleanup function used during setup rollback or teardown.
 * Errors are logged but not thrown (best-effort cleanup).
 *
 * @param ctx - OSC context with the user's PAT
 * @param serviceId - The OSC service ID
 * @param name - The instance name to remove
 */
export async function removeServiceInstance(
  ctx: Context,
  serviceId: string,
  name: string,
): Promise<void> {
  try {
    const sat = await ctx.getServiceAccessToken(serviceId);
    await removeInstance(ctx, serviceId, name, sat);
    logger.info(`Removed ${serviceId} instance "${name}"`);
  } catch (err) {
    logger.warn(`Failed to remove ${serviceId} instance "${name}": ${err}`);
  }
}

// ---------------------------------------------------------------------------
// FFmpeg Job Name Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a valid FFmpeg job name.
 *
 * FFmpeg-S3 instance names must be lowercase alphanumeric only (no hyphens,
 * underscores, or uppercase). This generates a name using a prefix and a
 * base-36 timestamp for uniqueness.
 *
 * @param prefix - A short lowercase prefix (e.g. "thumb", "proxy", "wave")
 * @returns A valid job name like "thumb1m5k7r2a"
 */
export function generateFfmpegJobName(prefix: string): string {
  const sanitized = prefix.toLowerCase().replace(/[^a-z0-9]/g, "");
  const timestamp = Date.now().toString(36);
  return `${sanitized}${timestamp}`;
}

// ---------------------------------------------------------------------------
// Exported Constants (for use in other modules)
// ---------------------------------------------------------------------------

export {
  MINIO_SERVICE_ID,
  VALKEY_SERVICE_ID,
  FFMPEG_SERVICE_ID,
};
