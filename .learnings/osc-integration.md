# OSC Integration Learnings

## Helmet v8 CSP Defaults Block Inline Event Handlers

**Problem**: Inline event handlers (`onclick`, etc.) were being blocked by CSP even though `script-src: 'unsafe-inline'` was set.

**Root Cause**: Helmet v8 sets `script-src-attr: 'none'` by default, which explicitly disallows inline attributes.

**Solution**: Explicitly set `scriptSrcAttr: ["'unsafe-inline'"]` in the CSP directives when configuring Helmet:
```typescript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],  // Required for onclick, etc.
      connectSrc: ["'self'", "https://*.auto.prod.osaas.io"],
    },
  },
}));
```

**Reference**: Open Media Management, MVP deployment Feb 2026

---

## APP_URL Mismatch with Custom Domains

**Problem**: OAuth callback failed with `invalid_callback` error after users logged in via custom domain.

**Root Cause**: OSC injects `APP_URL` pointing to the internal service URL (e.g. `oscaidev-openmediamgmt.eyevinn-web-runner.auto.prod.osaas.io`), NOT the custom domain. OAuth redirect URIs derived from `APP_URL` don't match the domain the user accessed, and session cookies scoped to the custom domain are missing on the internal domain callback.

**Solution**: Derive the base URL from request headers instead:
```typescript
const baseUrl = `${req.get("x-forwarded-proto") || "https"}://${req.get("x-forwarded-host")}`;
```

Also set `app.set("trust proxy", 1)` on Express so it trusts the proxy headers:
```typescript
app.set("trust proxy", 1);
```

This makes the app domain-agnostic and works with any custom domain without configuration changes.

**Reference**: Open Media Management, MVP deployment Feb 2026

---

## Custom Domain Mapping Uses eyevinn-web-runner Service ID

**Problem**: `create-my-domain` call with `eyevinn-app-is-deployed` created a mapping to a non-existent service.

**Solution**: My Apps deployed via `create-my-app` use `eyevinn-web-runner` as the underlying service ID for domain operations. Use this ID in `create-my-domain` and `update-my-domain` calls.

Additional note: if the instance already has an auto-generated domain, use `update-my-domain` instead of `create-my-domain`.

**Reference**: Open Media Management, MVP deployment Feb 2026

---

## Valkey Port Discovery via /ports Endpoint

**Problem**: The Valkey instance `url` field did not contain correct external connection info.

**Solution**: Call the `/ports/{name}` endpoint on `https://api-valkey-io-valkey.auto.prod.osaas.io` with a SAT bearer token to get `externalIp` and `externalPort`:
```typescript
const portsResponse = await fetch(`https://api-valkey-io-valkey.auto.prod.osaas.io/ports/${instanceName}`, {
  headers: { Authorization: `Bearer ${serviceAccessToken}` },
});
const { externalIp, externalPort } = await portsResponse.json();
```

**Reference**: Open Media Management, MVP deployment Feb 2026

---

## FFmpeg-S3 Job Names Must Be Lowercase Alphanumeric

**Problem**: Job creation failed with validation errors on hyphens and uppercase characters.

**Solution**: FFmpeg-S3 job names must match `/^[a-z0-9]+$/` (lowercase alphanumeric only, no hyphens, underscores, or uppercase). Jobs are ephemeral — create, poll for completion, then remove.

**Reference**: Open Media Management, MVP deployment Feb 2026

---

## @osaas/logging Named Exports Pattern

**Problem**: Logging was not working correctly with default import pattern.

**Solution**: Use named exports from `@osaas/logging`:
```typescript
import { Configure, Log } from "@osaas/logging";  // Correct
// NOT: import Log from "@osaas/logging";  // Wrong

// In main entry point
Configure();

// In each module
Log("info", "message");
```

**Reference**: Open Media Management, MVP deployment Feb 2026

---

## MinIO Presigned URLs and CSP

**Problem**: Browser uploads to MinIO presigned URLs were blocked by CSP.

**Root Cause**: Presigned URLs point to `*.minio-minio.auto.prod.osaas.io` domains, which were not in the CSP `connectSrc` allowlist.

**Solution**: Include `https://*.auto.prod.osaas.io` in CSP `connectSrc` to allow browser uploads to presigned URLs.

**Reference**: Open Media Management, MVP deployment Feb 2026

---

## Session Cookies Behind OSC Proxy

**Problem**: Session cookies were not being set or persisted correctly.

**Solution**: When running behind OSC's reverse proxy, set:
- `secure: true` — cookies only sent over HTTPS
- `sameSite: "lax"` — allows same-site navigation
- `app.set("trust proxy", 1)` — tells Express to trust proxy headers

Configuration:
```typescript
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  },
}));
```

**Reference**: Open Media Management, MVP deployment Feb 2026
