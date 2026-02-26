# Debugging Learnings

## CSP Inline Event Handler Blocked

**Error**: `Refused to execute a script for an inline event handler because 'unsafe-inline' does not appear in script-src`

**Root Cause**: Helmet v8 sets `script-src-attr: 'none'` by default, which explicitly blocks inline attributes like `onclick` even when `script-src: 'unsafe-inline'` is set.

**Diagnosis**:
- Check browser console for CSP violation errors
- Look at response headers: `Content-Security-Policy` should show `script-src-attr` directive

**Solution**: Add `scriptSrcAttr: ["'unsafe-inline'"]` to Helmet CSP configuration.

**Prevention**: Always check Helmet version changes in release notes — v8 changed CSP defaults.

**Reference**: Open Media Management, MVP Feb 2026

---

## OAuth Callback Error: invalid_callback

**Error**: After login, redirected to `/?error=invalid_callback`

**Root Cause**: OAuth redirect URI mismatch. The server built redirect URIs using `APP_URL` (pointing to internal service domain), but the user accessed the app via a custom domain. When the OAuth provider redirected to the internal domain, the session cookie (scoped to the custom domain) was missing, causing authentication to fail.

**Diagnosis**:
- Check OAuth console logs for redirect URI mismatches
- Verify request headers include `x-forwarded-host` pointing to custom domain
- Check session cookie domain in browser DevTools

**Solution**: Derive base URL from request headers instead of `APP_URL`:
```typescript
const baseUrl = `${req.get("x-forwarded-proto")}://${req.get("x-forwarded-host")}`;
```

Also set `app.set("trust proxy", 1)` so Express trusts these headers.

**Prevention**: Test with custom domains early in development, not just with auto-generated domains.

**Reference**: Open Media Management, MVP Feb 2026

---

## Domain Mapping Not Found

**Error**: `create-my-domain` returned "Service not found" or created mapping to non-existent service

**Root Cause**: Used `eyevinn-app-is-deployed` as the service ID, but My Apps use `eyevinn-web-runner` for domain operations.

**Diagnosis**:
- Check the MCP tool documentation for `create-my-domain`
- Verify the service ID in OSC console matches what you're passing

**Solution**: Always use `eyevinn-web-runner` for My Apps deployments. If the instance already has an auto-generated domain, use `update-my-domain` instead of `create-my-domain`.

**Prevention**: Document service ID conventions in architecture docs.

**Reference**: Open Media Management, MVP Feb 2026

---

## SPA Fallback Handler Blocking Event Loop

**Error**: Intermittent "Cannot find module" errors, SPA not loading for some routes

**Root Cause**: The SPA fallback route handler tried to use `await import("node:fs")` in a non-async handler, causing the event loop to block.

**Diagnosis**:
- Check server logs for "Cannot find module" errors
- Notice that some page loads work but others time out

**Solution**: Simplify to synchronous file operations or use `res.sendFile()` instead:
```typescript
// Before (wrong)
app.get("*", async (req, res) => {
  const fs = await import("node:fs");
  // ...
});

// After (correct)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
```

**Prevention**: Keep request handlers synchronous unless necessary. Use standard Node modules without dynamic imports.

**Reference**: Open Media Management, MVP Feb 2026

---

## GitHub Label Not Found

**Error**: Creating issues with labels that don't exist fails with "Label not found"

**Root Cause**: Attempted to reference labels in issues before they were created in the repository.

**Diagnosis**:
- Check GitHub API error response for "label not found"
- Verify labels exist in repository settings before referencing

**Solution**: Create all labels first with `gh label create` before referencing them in issue creation:
```bash
gh label create "bug" --description "Bug report"
gh label create "enhancement" --description "Feature request"
# Then create issues with --label flags
```

**Prevention**: Create labels as part of project setup, document the initial set-up script.

**Reference**: Open Media Management, MVP Feb 2026
