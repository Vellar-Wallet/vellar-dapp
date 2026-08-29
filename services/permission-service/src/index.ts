// @vellar/permission-service — dApp origin permissions, extension connection records, revocation state
// See CLAUDE.md and BUILD-PLAN.md before implementing.

// Re-export origin-validation utilities as the canonical permission-related API.
// These are sourced from @vellar/provider-sdk but exposed here so permission-service
// is the single import boundary for all origin/permission operations (issue #348).
export { hasCapability, normalizeOrigin, type PermissionGrant } from "@vellar/provider-sdk";
