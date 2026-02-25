# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## MCP Server

This project uses the Open Source Cloud MCP server. Add it with:

```bash
claude mcp add --transport http osc https://ai.svc.prod.osaas.io/mcp
```

## Project Overview

Open Media Management is a cloud-based Media Asset Management (MAM) system built on Eyevinn Open Source Cloud. It follows the canonical Express SPA pattern.

## Technology Stack

- **Runtime**: Node.js with TypeScript (ES2022, strict mode)
- **Framework**: Express.js
- **Module System**: ES Modules (`"type": "module"`)
- **Authentication**: OAuth 2.0 with PKCE via OSC
- **Storage**: S3-compatible (MinIO via OSC)
- **Metadata**: PostgreSQL or CouchDB via OSC
- **Cache/Queue**: Valkey (Redis-compatible via OSC)
- **Media Processing**: FFmpeg (ephemeral jobs via OSC)

## Key Patterns

1. **Authentication**: OAuth 2.0 + PKCE flow via `src/auth.ts`. Token refresh handled in middleware.
2. **Plan Gating**: PROFESSIONAL (199 EUR/mo) is minimum functional tier. FREE/PERSONAL see demo only.
3. **OSC Services**: Use `@osaas/client-core` for service instance management on user's account.
4. **API Convention**: Routes under `/api/<domain>/<action>`. JSON responses: `{ ok: true }` or `{ error: "message" }`.
5. **Error Handling**: Exponential backoff for transient failures. Graceful degradation if proxy generation fails.
6. **Logging**: Use `@osaas/logging` for structured logging.

## Common Commands

```bash
npm run dev        # Development with hot reload (requires .env)
npm run build      # Build for production
npm start          # Run production build
npm run typecheck  # Type checking only
npm run lint       # ESLint
```

## File Structure

```
src/
  server.ts      # Main Express application + API routes
  auth.ts        # OAuth 2.0 + PKCE implementation (shared pattern)
  public/
    index.html   # Single-page application
    style.css    # CSS custom properties design system
```

## OSC Service IDs

- `minio-minio` - S3-compatible storage (originals + proxies + thumbnails)
- `valkey-io-valkey` - Session store + search cache
- `eyevinn-ffmpeg-s3` - Ephemeral FFmpeg jobs (proxy/thumbnail generation)

## Plan Tiers

```typescript
const MAM_FUNCTIONAL_PLANS = ["PROFESSIONAL", "PRO", "ENTERPRISE", "BUSINESS"];
```

- FREE/PERSONAL: Demo library only (5 sample assets, read-only)
- PROFESSIONAL: Full MAM (upload, metadata, collections, search)
- BUSINESS: + Encore transcoding, auto-subtitles, API access
