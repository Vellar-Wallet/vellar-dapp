export interface PermissionServiceRuntimeConfig {
  originPermissionCacheTtlMs: number;
}

const DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_ORIGIN_PERMISSION_CACHE_TTL_MS = 1000;
const MAX_ORIGIN_PERMISSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULTS = {
  originPermissionCacheTtlMs: DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS,
  minOriginPermissionCacheTtlMs: MIN_ORIGIN_PERMISSION_CACHE_TTL_MS,
  maxOriginPermissionCacheTtlMs: MAX_ORIGIN_PERMISSION_CACHE_TTL_MS,
} as const;

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PermissionServiceRuntimeConfig {
  const configuredTtl = Number(env.PERMISSION_CACHE_TTL_MS);
  const originPermissionCacheTtlMs =
    Number.isFinite(configuredTtl) &&
    configuredTtl >= MIN_ORIGIN_PERMISSION_CACHE_TTL_MS &&
    configuredTtl <= MAX_ORIGIN_PERMISSION_CACHE_TTL_MS
      ? configuredTtl
      : DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS;

  return { originPermissionCacheTtlMs };
}
