import crypto from "node:crypto";
import type { Redis } from "ioredis";
import { Log } from "@osaas/logging";

const log = Log();

// ---------------------------------------------------------------------------
// Data Models
// ---------------------------------------------------------------------------

export interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  duration?: number;
  resolution?: string;
  codec?: string;
  title: string;
  description: string;
  tags: string[];
  customMeta: Record<string, string>;
  minioKey: string;
  proxyKey?: string;
  thumbnailKey?: string;
  posterKey?: string;
  proxyStatus: "pending" | "processing" | "ready" | "failed" | "none";
  collections: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  coverAssetId?: string;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Valkey Key Helpers
// ---------------------------------------------------------------------------

const KEYS = {
  asset: (id: string) => `asset:${id}`,
  assetsIndex: "assets:index",
  assetsByCollection: (collectionId: string) =>
    `assets:by-collection:${collectionId}`,
  collection: (id: string) => `collection:${id}`,
  collectionsIndex: "collections:index",
  tagsAll: "tags:all",
  searchWord: (word: string) => `search:word:${word}`,
} as const;

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function parseAsset(raw: string | null): Asset | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Asset;
  } catch {
    log.error("Failed to parse asset JSON");
    return null;
  }
}

function parseCollection(raw: string | null): Collection | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Collection;
  } catch {
    log.error("Failed to parse collection JSON");
    return null;
  }
}

/** Extract indexable words from an asset's text fields. */
function extractWords(asset: Asset): string[] {
  const text = [asset.title, asset.description, ...asset.tags]
    .join(" ")
    .toLowerCase();
  const words = text.match(/[a-z0-9\u00C0-\u024F]+/g);
  if (!words) return [];
  // Deduplicate and filter very short words
  return [...new Set(words)].filter((w) => w.length >= 2);
}

// ---------------------------------------------------------------------------
// Search Index Helpers
// ---------------------------------------------------------------------------

async function indexAssetForSearch(
  redis: Redis,
  asset: Asset,
): Promise<void> {
  const words = extractWords(asset);
  const pipeline = redis.pipeline();
  for (const word of words) {
    pipeline.sadd(KEYS.searchWord(word), asset.id);
  }
  await pipeline.exec();
}

async function removeAssetFromSearchIndex(
  redis: Redis,
  asset: Asset,
): Promise<void> {
  const words = extractWords(asset);
  const pipeline = redis.pipeline();
  for (const word of words) {
    pipeline.srem(KEYS.searchWord(word), asset.id);
  }
  await pipeline.exec();
}

// ---------------------------------------------------------------------------
// Asset CRUD
// ---------------------------------------------------------------------------

export async function createAsset(
  redis: Redis,
  input: Omit<Asset, "id" | "createdAt" | "updatedAt">,
): Promise<Asset> {
  const now = new Date().toISOString();
  const asset: Asset = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  const pipeline = redis.pipeline();

  // Store asset data
  pipeline.set(KEYS.asset(asset.id), JSON.stringify(asset));

  // Add to sorted index (score = unix timestamp for createdAt ordering)
  pipeline.zadd(KEYS.assetsIndex, Date.now(), asset.id);

  // Index tags
  for (const tag of asset.tags) {
    pipeline.zincrby(KEYS.tagsAll, 1, tag.toLowerCase());
  }

  // Add to any referenced collections
  for (const collectionId of asset.collections) {
    pipeline.sadd(KEYS.assetsByCollection(collectionId), asset.id);
  }

  await pipeline.exec();

  // Build search index (separate pipeline for clarity)
  await indexAssetForSearch(redis, asset);

  log.info(`Asset created: ${asset.id} (${asset.filename})`);
  return asset;
}

export async function getAsset(
  redis: Redis,
  id: string,
): Promise<Asset | null> {
  const raw = await redis.get(KEYS.asset(id));
  return parseAsset(raw);
}

export async function updateAsset(
  redis: Redis,
  id: string,
  updates: Partial<Asset>,
): Promise<Asset | null> {
  const existing = await getAsset(redis, id);
  if (!existing) return null;

  // Remove old search index entries before applying updates
  await removeAssetFromSearchIndex(redis, existing);

  // Compute tag differences for the tags:all sorted set
  const oldTags = existing.tags.map((t) => t.toLowerCase());
  const newTags = (updates.tags ?? existing.tags).map((t) => t.toLowerCase());

  const merged: Asset = {
    ...existing,
    ...updates,
    // Protect immutable fields
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  const pipeline = redis.pipeline();
  pipeline.set(KEYS.asset(id), JSON.stringify(merged));

  // Adjust tag counts
  const addedTags = newTags.filter((t) => !oldTags.includes(t));
  const removedTags = oldTags.filter((t) => !newTags.includes(t));

  for (const tag of addedTags) {
    pipeline.zincrby(KEYS.tagsAll, 1, tag);
  }
  for (const tag of removedTags) {
    pipeline.zincrby(KEYS.tagsAll, -1, tag);
  }

  // Handle collection membership changes
  const oldCollections = existing.collections;
  const newCollections = updates.collections ?? existing.collections;

  const addedCollections = newCollections.filter(
    (c) => !oldCollections.includes(c),
  );
  const removedCollections = oldCollections.filter(
    (c) => !newCollections.includes(c),
  );

  for (const cid of addedCollections) {
    pipeline.sadd(KEYS.assetsByCollection(cid), id);
  }
  for (const cid of removedCollections) {
    pipeline.srem(KEYS.assetsByCollection(cid), id);
  }

  await pipeline.exec();

  // Rebuild search index with updated content
  await indexAssetForSearch(redis, merged);

  log.info(`Asset updated: ${id}`);
  return merged;
}

export async function deleteAsset(
  redis: Redis,
  id: string,
): Promise<boolean> {
  const asset = await getAsset(redis, id);
  if (!asset) return false;

  // Remove from search index
  await removeAssetFromSearchIndex(redis, asset);

  const pipeline = redis.pipeline();

  // Remove asset data
  pipeline.del(KEYS.asset(id));

  // Remove from main index
  pipeline.zrem(KEYS.assetsIndex, id);

  // Decrement tag counts
  for (const tag of asset.tags) {
    pipeline.zincrby(KEYS.tagsAll, -1, tag.toLowerCase());
  }

  // Remove from all collections
  for (const collectionId of asset.collections) {
    pipeline.srem(KEYS.assetsByCollection(collectionId), id);
  }

  await pipeline.exec();

  // Clean up tags with zero or negative scores
  await redis.zremrangebyscore(KEYS.tagsAll, "-inf", "0");

  log.info(`Asset deleted: ${id} (${asset.filename})`);
  return true;
}

// ---------------------------------------------------------------------------
// Asset Listing & Search
// ---------------------------------------------------------------------------

export async function listAssets(
  redis: Redis,
  opts?: {
    page?: number;
    limit?: number;
    sort?: "createdAt" | "title" | "fileSize" | "duration";
    order?: "asc" | "desc";
    type?: string;
    collectionId?: string;
  },
): Promise<{ assets: Asset[]; total: number }> {
  const page = Math.max(1, opts?.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
  const sort = opts?.sort ?? "createdAt";
  const order = opts?.order ?? "desc";
  const typeFilter = opts?.type?.toLowerCase();

  let assetIds: string[];

  if (opts?.collectionId) {
    // Fetch asset IDs belonging to a specific collection
    assetIds = await redis.smembers(
      KEYS.assetsByCollection(opts.collectionId),
    );
  } else {
    // Fetch all asset IDs from the sorted index
    assetIds = await redis.zrange(KEYS.assetsIndex, 0, -1);
  }

  if (assetIds.length === 0) {
    return { assets: [], total: 0 };
  }

  // Fetch all asset data in bulk
  const pipeline = redis.pipeline();
  for (const id of assetIds) {
    pipeline.get(KEYS.asset(id));
  }
  const results = await pipeline.exec();

  let assets: Asset[] = [];
  if (results) {
    for (const [err, raw] of results) {
      if (!err && raw) {
        const asset = parseAsset(raw as string);
        if (asset) assets.push(asset);
      }
    }
  }

  // Apply mime type filter
  if (typeFilter) {
    assets = assets.filter((a) =>
      a.mimeType.toLowerCase().startsWith(typeFilter),
    );
  }

  const total = assets.length;

  // Sort in memory (acceptable for MVP scale)
  assets.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      case "fileSize":
        cmp = a.fileSize - b.fileSize;
        break;
      case "duration":
        cmp = (a.duration ?? 0) - (b.duration ?? 0);
        break;
      case "createdAt":
      default:
        cmp = a.createdAt.localeCompare(b.createdAt);
        break;
    }
    return order === "asc" ? cmp : -cmp;
  });

  // Paginate
  const start = (page - 1) * limit;
  const paged = assets.slice(start, start + limit);

  return { assets: paged, total };
}

export async function searchAssets(
  redis: Redis,
  query: string,
  opts?: {
    page?: number;
    limit?: number;
    type?: string;
  },
): Promise<{ assets: Asset[]; total: number }> {
  const page = Math.max(1, opts?.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
  const typeFilter = opts?.type?.toLowerCase();

  const queryWords = query
    .toLowerCase()
    .match(/[a-z0-9\u00C0-\u024F]+/g);

  if (!queryWords || queryWords.length === 0) {
    return { assets: [], total: 0 };
  }

  // For each query word, get matching asset IDs from the search index
  const wordKeys = queryWords
    .filter((w) => w.length >= 2)
    .map((w) => KEYS.searchWord(w));

  if (wordKeys.length === 0) {
    return { assets: [], total: 0 };
  }

  // Intersect all word sets to find assets matching ALL terms
  let matchingIds: string[];
  if (wordKeys.length === 1) {
    matchingIds = await redis.smembers(wordKeys[0]);
  } else {
    // Use SINTER for multi-word AND search
    matchingIds = await redis.sinter(...wordKeys);
  }

  if (matchingIds.length === 0) {
    return { assets: [], total: 0 };
  }

  // Fetch matching assets
  const pipeline = redis.pipeline();
  for (const id of matchingIds) {
    pipeline.get(KEYS.asset(id));
  }
  const results = await pipeline.exec();

  let assets: Asset[] = [];
  if (results) {
    for (const [err, raw] of results) {
      if (!err && raw) {
        const asset = parseAsset(raw as string);
        if (asset) assets.push(asset);
      }
    }
  }

  // Apply mime type filter
  if (typeFilter) {
    assets = assets.filter((a) =>
      a.mimeType.toLowerCase().startsWith(typeFilter),
    );
  }

  const total = assets.length;

  // Sort by relevance (createdAt descending as default for MVP)
  assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Paginate
  const start = (page - 1) * limit;
  const paged = assets.slice(start, start + limit);

  return { assets: paged, total };
}

// ---------------------------------------------------------------------------
// Collection CRUD
// ---------------------------------------------------------------------------

export async function createCollection(
  redis: Redis,
  name: string,
  description?: string,
): Promise<Collection> {
  const now = new Date().toISOString();
  const collection: Collection = {
    id: crypto.randomUUID(),
    name,
    description: description ?? "",
    assetCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const pipeline = redis.pipeline();
  pipeline.set(KEYS.collection(collection.id), JSON.stringify(collection));
  pipeline.zadd(KEYS.collectionsIndex, Date.now(), collection.id);
  await pipeline.exec();

  log.info(`Collection created: ${collection.id} (${name})`);
  return collection;
}

export async function getCollection(
  redis: Redis,
  id: string,
): Promise<Collection | null> {
  const raw = await redis.get(KEYS.collection(id));
  return parseCollection(raw);
}

export async function updateCollection(
  redis: Redis,
  id: string,
  updates: Partial<Collection>,
): Promise<Collection | null> {
  const existing = await getCollection(redis, id);
  if (!existing) return null;

  const merged: Collection = {
    ...existing,
    ...updates,
    // Protect immutable fields
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await redis.set(KEYS.collection(id), JSON.stringify(merged));

  log.info(`Collection updated: ${id}`);
  return merged;
}

export async function deleteCollection(
  redis: Redis,
  id: string,
): Promise<boolean> {
  const collection = await getCollection(redis, id);
  if (!collection) return false;

  // Get all assets in this collection so we can update their membership
  const assetIds = await redis.smembers(KEYS.assetsByCollection(id));

  const pipeline = redis.pipeline();

  // Remove collection data and index entry
  pipeline.del(KEYS.collection(id));
  pipeline.zrem(KEYS.collectionsIndex, id);

  // Remove the collection-asset set
  pipeline.del(KEYS.assetsByCollection(id));

  // Update each asset's collections array to remove this collection
  for (const assetId of assetIds) {
    // We need to read and rewrite each asset; queue the reads
    pipeline.get(KEYS.asset(assetId));
  }

  const results = await pipeline.exec();

  // Now update each asset that was in this collection
  if (assetIds.length > 0 && results) {
    const updatePipeline = redis.pipeline();
    // Results for asset GETs start after the 3 initial commands (del, zrem, del)
    const assetResultsOffset = 3;

    for (let i = 0; i < assetIds.length; i++) {
      const [err, raw] = results[assetResultsOffset + i];
      if (err || !raw) continue;

      const asset = parseAsset(raw as string);
      if (!asset) continue;

      asset.collections = asset.collections.filter((c) => c !== id);
      asset.updatedAt = new Date().toISOString();
      updatePipeline.set(KEYS.asset(asset.id), JSON.stringify(asset));
    }

    await updatePipeline.exec();
  }

  log.info(`Collection deleted: ${id} (${collection.name})`);
  return true;
}

export async function listCollections(redis: Redis): Promise<Collection[]> {
  const ids = await redis.zrange(KEYS.collectionsIndex, 0, -1);
  if (ids.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const id of ids) {
    pipeline.get(KEYS.collection(id));
  }
  const results = await pipeline.exec();

  const collections: Collection[] = [];
  if (results) {
    for (const [err, raw] of results) {
      if (!err && raw) {
        const collection = parseCollection(raw as string);
        if (collection) collections.push(collection);
      }
    }
  }

  // Sort by createdAt descending (newest first)
  collections.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return collections;
}

// ---------------------------------------------------------------------------
// Collection-Asset Relationships
// ---------------------------------------------------------------------------

export async function addAssetToCollection(
  redis: Redis,
  collectionId: string,
  assetId: string,
): Promise<void> {
  const [collection, asset] = await Promise.all([
    getCollection(redis, collectionId),
    getAsset(redis, assetId),
  ]);

  if (!collection) {
    throw new Error(`Collection not found: ${collectionId}`);
  }
  if (!asset) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  // Check if already a member
  const isMember = await redis.sismember(
    KEYS.assetsByCollection(collectionId),
    assetId,
  );
  if (isMember) return;

  const pipeline = redis.pipeline();

  // Add to the collection's asset set
  pipeline.sadd(KEYS.assetsByCollection(collectionId), assetId);

  // Update the asset's collections array
  asset.collections = [...asset.collections, collectionId];
  asset.updatedAt = new Date().toISOString();
  pipeline.set(KEYS.asset(assetId), JSON.stringify(asset));

  // Increment the collection's asset count
  collection.assetCount += 1;
  collection.updatedAt = new Date().toISOString();
  pipeline.set(KEYS.collection(collectionId), JSON.stringify(collection));

  await pipeline.exec();

  log.info(`Asset ${assetId} added to collection ${collectionId}`);
}

export async function removeAssetFromCollection(
  redis: Redis,
  collectionId: string,
  assetId: string,
): Promise<void> {
  const [collection, asset] = await Promise.all([
    getCollection(redis, collectionId),
    getAsset(redis, assetId),
  ]);

  if (!collection) {
    throw new Error(`Collection not found: ${collectionId}`);
  }
  if (!asset) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  // Check if actually a member
  const isMember = await redis.sismember(
    KEYS.assetsByCollection(collectionId),
    assetId,
  );
  if (!isMember) return;

  const pipeline = redis.pipeline();

  // Remove from the collection's asset set
  pipeline.srem(KEYS.assetsByCollection(collectionId), assetId);

  // Update the asset's collections array
  asset.collections = asset.collections.filter((c) => c !== collectionId);
  asset.updatedAt = new Date().toISOString();
  pipeline.set(KEYS.asset(assetId), JSON.stringify(asset));

  // Decrement the collection's asset count
  collection.assetCount = Math.max(0, collection.assetCount - 1);
  collection.updatedAt = new Date().toISOString();

  // If this was the cover asset, clear it
  if (collection.coverAssetId === assetId) {
    collection.coverAssetId = undefined;
  }

  pipeline.set(KEYS.collection(collectionId), JSON.stringify(collection));

  await pipeline.exec();

  log.info(`Asset ${assetId} removed from collection ${collectionId}`);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function getAllTags(redis: Redis): Promise<string[]> {
  // Return tags sorted by usage count (highest first)
  const tagsWithScores = await redis.zrevrange(KEYS.tagsAll, 0, -1);
  return tagsWithScores;
}
