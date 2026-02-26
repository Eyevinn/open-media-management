# Technical Decisions

## Valkey (Redis) for Metadata Storage Instead of PostgreSQL

**Decision**: Use Valkey (Redis-compatible) for asset metadata storage in MVP.

**Rationale**:
- **Simpler provisioning**: Single OSC service vs. database setup
- **Sufficient for MVP scale**: Hundreds of assets per user
- **JSON + indexing**: Valkey supports JSON values with sorted set indexes for basic querying
- **In-memory performance**: Fast reads for UI list views

**Trade-offs**:
- No SQL joins — all data is denormalized
- Manual sorting/filtering done in-memory
- Search requires inverted word sets built and maintained in code
- No transactional guarantees across multiple keys

**Future**: PostgreSQL recommended for post-MVP scale (thousands+ assets, complex queries).

**Reference**: Open Media Management, MVP Feb 2026

---

## Per-User Service Provisioning

**Decision**: Each authenticated user gets their own MinIO + Valkey instances on their OSC account.

**Rationale**:
- **Data isolation**: Clean tenant separation without application-level filtering
- **Per-tenant limits**: Each user's storage quota is enforced by their account limits
- **Simplified billing**: Token consumption per user is clear

**Implementation**:
- Services lazily provisioned on first API call via `ensureUserServices` middleware
- Credentials stored in session for request lifetime
- S3/Redis clients cached in-memory Map keyed by user ID

**Trade-off**: Each user consumes separate service instances, increasing OSC account overhead.

**Reference**: Open Media Management, MVP Feb 2026

---

## Fire-and-Forget Proxy Generation

**Decision**: FFmpeg proxy/thumbnail jobs run asynchronously after upload confirmation.

**Rationale**:
- **Non-blocking uploads**: User gets immediate confirmation
- **UX**: Proxy/thumbnails appear in sidebar as they complete
- **Resilient**: Job failures don't block the core upload

**Implementation**:
- Server triggers the FFmpeg-S3 job and returns immediately
- Frontend polls `/api/assets/:id/proxy-status` every 5 seconds
- Status endpoint returns current job state (queued, processing, complete, error)

**Trade-off**: Adds complexity (polling loop) vs. blocking until complete.

**Reference**: Open Media Management, MVP Feb 2026

---

## Request-Derived Base URL Over APP_URL

**Decision**: OAuth redirect URIs and service URLs derived from request headers, not `APP_URL` environment variable.

**Rationale**:
- **Domain-agnostic**: Works with any custom domain without configuration
- **Dynamic routing**: Adapts to custom domain mappings at runtime
- **Zero config for domains**: No need to update env vars when adding a custom domain

**Implementation**:
```typescript
const baseUrl = `${req.get("x-forwarded-proto") || "https"}://${req.get("x-forwarded-host")}`;
```

**Trade-off**: Requires `trust proxy` to be set and assumes reverse proxy injects correct headers.

**Reference**: Open Media Management, MVP Feb 2026

---

## Vanilla JS SPA Over Framework

**Decision**: Frontend built with vanilla HTML/CSS/JS following the canonical Express SPA pattern.

**Rationale**:
- **No build step**: Simple deployment (just copy `public/` to distribution)
- **Alignment**: Matches reference products (open-media-convert, etc.)
- **Minimal dependencies**: Reduces attack surface and bundle size

**Trade-off**: No component reusability or state management frameworks — all state managed via DOM and fetch.

**Reference**: Open Media Management, MVP Feb 2026
