export interface PermissionServiceRuntimeConfig {
  originPermissionCacheTtlMs: number;
  /** Validated origin-matching patterns (glob-style, `*` wildcard). */
  originPatterns: string[];
  /** Non-fatal findings surfaced at boot (e.g. a pattern that matches nothing). */
  warnings: string[];
}

const DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_ORIGIN_PERMISSION_CACHE_TTL_MS = 1000;
const MAX_ORIGIN_PERMISSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULTS = {
  originPermissionCacheTtlMs: DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS,
  minOriginPermissionCacheTtlMs: MIN_ORIGIN_PERMISSION_CACHE_TTL_MS,
  maxOriginPermissionCacheTtlMs: MAX_ORIGIN_PERMISSION_CACHE_TTL_MS,
  originPatterns: [] as readonly string[],
} as const;

/** Thrown at boot when a configured origin pattern is malformed, so the
 * service fails fast instead of erroring on the first match attempt. */
export class OriginPatternError extends Error {
  constructor(
    message: string,
    readonly pattern: string,
  ) {
    super(message);
    this.name = "OriginPatternError";
  }
}

/**
 * Compiles a glob-style origin pattern (`*` matches any run of characters)
 * into an anchored RegExp. Throws `OriginPatternError` when the pattern is
 * not usable syntax — the same failure mode a match attempt would hit later,
 * only now it happens at boot and names the offending pattern.
 */
export function compileOriginPattern(pattern: string): RegExp {
  const source = `^${pattern.replace(/\*/g, ".*")}$`;
  try {
    return new RegExp(source);
  } catch (err) {
    throw new OriginPatternError(
      `invalid origin pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`,
      pattern,
    );
  }
}

/**
 * Validates every configured origin pattern at boot.
 *
 * - A pattern that cannot be compiled (invalid regex/glob syntax) throws
 *   `OriginPatternError` and fails boot, naming the pattern.
 * - A pattern that is syntactically valid but can never match a real origin
 *   (e.g. empty / whitespace-only) is recorded as a warning, not a failure.
 */
export function validateOriginPatterns(patterns: string[]): {
  valid: string[];
  warnings: string[];
} {
  const valid: string[] = [];
  const warnings: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    // Syntactically fine but semantically useless: an empty pattern compiles
    // to `^$`, which only ever matches the empty string — never an Origin.
    if (pattern === "") {
      warnings.push(`origin pattern ${JSON.stringify(raw)} matches nothing and is ignored`);
      continue;
    }
    // Throws OriginPatternError on malformed syntax — fail boot here, not on
    // the first match attempt against the broken pattern.
    compileOriginPattern(pattern);
    valid.push(pattern);
  }
  return { valid, warnings };
}

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

  const rawPatterns = env.PERMISSION_ORIGIN_PATTERNS ?? "";
  const patterns = rawPatterns === "" ? [] : rawPatterns.split(",").map((p) => p.trim());

  const { valid, warnings } = validateOriginPatterns(patterns);

  return { originPermissionCacheTtlMs, originPatterns: valid, warnings };
}
