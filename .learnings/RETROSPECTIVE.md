# Retrospective: Open Media Management MVP - February 2026

## What Went Well

- **Quick iteration on architecture**: Moving from PostgreSQL to Valkey reduced initial setup time and aligned with MVP goals
- **Canonical pattern validation**: Express SPA pattern with vanilla JS proved effective — simple deployment, no build complexity
- **Per-user isolation working**: Lazy service provisioning with in-session credentials cleanly separated tenants
- **OSC platform stability**: Services deployed reliably; no platform outages during testing
- **Fire-and-forget job pattern**: Asynchronous proxy generation kept upload UX responsive without blocking
- **Team documentation**: CLAUDE.md and reference products provided clear architectural guidance

## What Could Improve

- **CSP configuration discovery**: Helmet v8 CSP defaults were not immediately obvious; took debugging to discover `script-src-attr: 'none'` issue. Recommend: CSP testing checklist in project setup.
- **APP_URL gotcha documentation**: The request-header-based URL derivation wasn't documented in CLAUDE.md; team discovered it through trial and error. Recommend: Add to OSC Integration section.
- **Service ID naming conventions**: `eyevinn-web-runner` vs. `eyevinn-app-is-deployed` unclear until tested in console. Recommend: MCP tools documentation or internal wiki.
- **Session cookie configuration**: Multiple attempts needed to get cookies working behind proxy. Recommend: Template in canonical pattern with correct proxy settings.
- **Valkey limitations**: Manual search indexing and in-memory sorting added complexity. Recommend: Document for post-MVP when scale requires PostgreSQL migration.

## Action Items

1. **Update CLAUDE.md**: Add request-header-based URL derivation pattern to canonical product architecture
2. **Create CSP checklist**: Document Helmet v8 defaults and recommended settings for media products
3. **Add service ID reference**: Document which OSC service IDs are used for which MCP tool operations
4. **Session cookie template**: Include proxy-aware session configuration in canonical Express SPA pattern
5. **Valkey migration guide**: Draft post-MVP guide for migrating from Valkey to PostgreSQL

## Learnings Captured

- **osc-integration.md**: 8 learnings on OSC API quirks (Helmet CSP, APP_URL, service IDs, Valkey, FFmpeg naming, logging patterns, MinIO/CSP, session cookies)
- **technical-decisions.md**: 5 major architectural decisions with rationale and trade-offs
- **debugging.md**: 5 debugging scenarios with root causes, diagnosis, and solutions

## Product Status

**MVP successfully deployed** with:
- User authentication via OSC OAuth
- Per-user MinIO + Valkey provisioning
- Asset upload with proxy/thumbnail generation
- Custom domain support
- Responsive vanilla JS UI

**Ready for**: Beta testing with early adopter users, gathering feedback on metadata UX and asset organization features.

**Next phase**: Post-MVP enhancements based on user feedback, PostgreSQL migration if scale demands it.

---

**Date**: February 26, 2026
**Team Lead**: Self-Improvement Agent
**Status**: Complete
