import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Log } from "@osaas/logging";

const log = Log();

const BUCKET = "media-assets";

const PREFIXES = {
  original: "originals",
  proxy: "proxies",
  thumbnail: "thumbnails",
  poster: "posters",
} as const;

export interface MinioCredentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  consoleUrl: string;
}

export interface StorageInfo {
  totalObjects: number;
  totalSizeBytes: number;
  byType: Record<string, { count: number; sizeBytes: number }>;
}

/**
 * Create an S3-compatible client configured for a MinIO instance.
 * Uses path-style addressing and region `us-east-1` as required by MinIO.
 */
export function createS3Client(creds: MinioCredentials): S3Client {
  return new S3Client({
    endpoint: creds.endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

/**
 * Ensure the media-assets bucket exists.
 * Creates it if missing; silently succeeds if it already exists.
 */
export async function ensureBucket(
  client: S3Client,
  bucket: string = BUCKET,
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    log.info(`Bucket "${bucket}" already exists`);
  } catch (headErr: unknown) {
    // Bucket does not exist (404) or we have no access -- try to create it
    log.info(`Bucket "${bucket}" not found, creating...`);
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      log.info(`Bucket "${bucket}" created`);
    } catch (createErr: unknown) {
      const code =
        createErr instanceof Error
          ? (createErr as Error & { Code?: string }).Code ??
            (createErr as Error & { name?: string }).name
          : undefined;

      if (
        code === "BucketAlreadyOwnedByYou" ||
        code === "BucketAlreadyExists"
      ) {
        log.info(`Bucket "${bucket}" already exists (race condition resolved)`);
        return;
      }
      log.error(`Failed to create bucket "${bucket}"`, createErr);
      throw createErr;
    }
  }
}

/**
 * Generate a presigned URL for uploading a file (HTTP PUT) to the originals prefix.
 *
 * The resulting key is `originals/{assetId}/{filename}`.
 *
 * @param client    - S3Client for the user's MinIO instance
 * @param assetId   - Unique asset identifier
 * @param filename  - Original file name (preserved for downstream use)
 * @param contentType - MIME type of the file being uploaded
 * @param expiresIn - URL validity in seconds (default 3600)
 * @returns Presigned PUT URL
 */
export async function getUploadUrl(
  client: S3Client,
  assetId: string,
  filename: string,
  contentType: string,
  expiresIn: number = 3600,
): Promise<string> {
  const key = `${PREFIXES.original}/${assetId}/${filename}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(client, command, { expiresIn });
  log.info(`Generated presigned upload URL for key="${key}"`);
  return url;
}

/**
 * Generate a presigned URL for downloading (HTTP GET) any object by key.
 *
 * @param client    - S3Client for the user's MinIO instance
 * @param key       - Full object key (e.g. `proxies/{assetId}/proxy.mp4`)
 * @param expiresIn - URL validity in seconds (default 3600)
 * @returns Presigned GET URL
 */
export async function getDownloadUrl(
  client: S3Client,
  key: string,
  expiresIn: number = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  const url = await getSignedUrl(client, command, { expiresIn });
  log.info(`Generated presigned download URL for key="${key}"`);
  return url;
}

/**
 * Delete all objects associated with a given asset across every prefix
 * (originals, proxies, thumbnails, posters).
 *
 * Objects are discovered via ListObjectsV2 under each prefix and removed
 * in a single batched DeleteObjects call per prefix.
 */
export async function deleteAssetObjects(
  client: S3Client,
  assetId: string,
): Promise<void> {
  const prefixValues = Object.values(PREFIXES);

  for (const prefix of prefixValues) {
    const fullPrefix = `${prefix}/${assetId}/`;
    const objects = await listObjectsInternal(client, fullPrefix);

    if (objects.length === 0) {
      continue;
    }

    const deleteParams = {
      Bucket: BUCKET,
      Delete: {
        Objects: objects.map((obj) => ({ Key: obj.key })),
        Quiet: true,
      },
    };

    await client.send(new DeleteObjectsCommand(deleteParams));
    log.info(
      `Deleted ${objects.length} object(s) under prefix "${fullPrefix}"`,
    );
  }
}

/**
 * Return storage usage information for the entire media-assets bucket,
 * categorised by object type (originals, proxies, thumbnails, posters, other).
 */
export async function getStorageInfo(client: S3Client): Promise<StorageInfo> {
  const info: StorageInfo = {
    totalObjects: 0,
    totalSizeBytes: 0,
    byType: {},
  };

  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of response.Contents ?? []) {
      const size = obj.Size ?? 0;
      info.totalObjects += 1;
      info.totalSizeBytes += size;

      const typeName = categoriseKey(obj.Key ?? "");

      if (!info.byType[typeName]) {
        info.byType[typeName] = { count: 0, sizeBytes: 0 };
      }
      info.byType[typeName].count += 1;
      info.byType[typeName].sizeBytes += size;
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  log.info(
    `Storage info: ${info.totalObjects} objects, ${info.totalSizeBytes} bytes`,
  );
  return info;
}

/**
 * List objects under a given prefix in the media-assets bucket.
 * Handles pagination transparently and returns all matching objects.
 */
export async function listObjects(
  client: S3Client,
  prefix: string,
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  return listObjectsInternal(client, prefix);
}

/**
 * Build an S3 URI for use with FFmpeg / Encore jobs that access S3 directly
 * (not presigned). The URI includes the bucket name and the canonical key.
 *
 * @param assetId  - Unique asset identifier
 * @param type     - Object type: original, proxy, thumbnail, or poster
 * @param filename - File name (required for originals, defaults vary for others)
 * @returns s3://media-assets/{prefix}/{assetId}/{filename}
 */
export function getS3Uri(
  assetId: string,
  type: "original" | "proxy" | "thumbnail" | "poster",
  filename?: string,
): string {
  const prefix = PREFIXES[type];

  const defaultNames: Record<string, string> = {
    proxy: "proxy.mp4",
    thumbnail: "thumb.jpg",
    poster: "poster.jpg",
  };

  const resolvedFilename = filename ?? defaultNames[type];

  if (!resolvedFilename) {
    throw new Error(
      `Filename is required for type "${type}" when no default exists`,
    );
  }

  return `s3://${BUCKET}/${prefix}/${assetId}/${resolvedFilename}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Internal paginated list that returns all objects under a given prefix.
 */
async function listObjectsInternal(
  client: S3Client,
  prefix: string,
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  const results: Array<{ key: string; size: number; lastModified: Date }> = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of response.Contents ?? []) {
      results.push({
        key: obj.Key ?? "",
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
      });
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return results;
}

/**
 * Categorise an object key into one of the known types based on its prefix,
 * or return "other" for unrecognised prefixes.
 */
function categoriseKey(key: string): string {
  if (key.startsWith(`${PREFIXES.original}/`)) return "originals";
  if (key.startsWith(`${PREFIXES.proxy}/`)) return "proxies";
  if (key.startsWith(`${PREFIXES.thumbnail}/`)) return "thumbnails";
  if (key.startsWith(`${PREFIXES.poster}/`)) return "posters";
  return "other";
}
