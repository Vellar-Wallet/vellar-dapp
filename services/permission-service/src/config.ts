import { normalizeOrigin } from "@vellar/provider-sdk";

export interface OriginPatternWarning {
  pattern: string;
  reason: string;
}

export interface CompiledOriginPattern {
  pattern: string;
  regex: RegExp;
  matchesNothing: boolean;
  matches(origin: string): boolean;
}

export interface PermissionServiceRuntimeConfig {
  originPermissionCacheTtlMs: number;
  allowedOriginPatterns: CompiledOriginPattern[];
  originPatternWarnings: OriginPatternWarning[];
}

export class OriginPatternConfigError extends Error {
  readonly pattern: string;

  constructor(pattern: string, reason: string) {
    super(`Invalid origin pattern "${pattern}": ${reason}`);
    this.name = "OriginPatternConfigError";
    this.pattern = pattern;
  }
}

export interface ValidateOriginPatternsOptions {
  onWarn?: (warning: OriginPatternWarning) => void;
}

export interface ValidatedOriginPatterns {
  patterns: CompiledOriginPattern[];
  warnings: OriginPatternWarning[];
}

const DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_ORIGIN_PERMISSION_CACHE_TTL_MS = 1000;
const MAX_ORIGIN_PERMISSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULTS = {
  originPermissionCacheTtlMs: DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS,
  minOriginPermissionCacheTtlMs: MIN_ORIGIN_PERMISSION_CACHE_TTL_MS,
  maxOriginPermissionCacheTtlMs: MAX_ORIGIN_PERMISSION_CACHE_TTL_MS,
} as const;

const IPV4_HOST_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRegexMatchImpossibleForOrigin(source: string): string | undefined {
  if (
    source === "(?!)" ||
    source === "^(?!)" ||
    source === "^$" ||
    source === "\\b\\B" ||
    source.includes("(?!)")
  ) {
    return "regular expression is unsatisfiable and matches no origins";
  }
  if (/^\^(?!https?:|\\\/\\\/|\(\?:https\?)/.test(source) && !source.includes("http")) {
    return "regular expression cannot match any normalized http(s) origin";
  }
  return undefined;
}

function compileSingleOriginPattern(rawPattern: string): {
  compiled: CompiledOriginPattern;
  warning?: OriginPatternWarning;
} {
  const pattern = rawPattern.trim();
  if (pattern.length === 0) {
    throw new OriginPatternConfigError(rawPattern, "pattern must not be empty");
  }

  if (pattern === "*" || pattern === "*://*" || pattern === "https://*" || pattern === "http://*") {
    throw new OriginPatternConfigError(
      rawPattern,
      "unbounded wildcard origin pattern is not allowed",
    );
  }

  // Regex literal syntax: /.../
  if (pattern.startsWith("/")) {
    if (!pattern.endsWith("/") || pattern.length < 2) {
      throw new OriginPatternConfigError(
        rawPattern,
        "unterminated regular expression literal (expected closing '/')",
      );
    }
    const source = pattern.slice(1, -1);
    if (source.length === 0) {
      throw new OriginPatternConfigError(
        rawPattern,
        "regular expression pattern must not be empty",
      );
    }
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch (err) {
      throw new OriginPatternConfigError(
        rawPattern,
        `malformed regular expression (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const deadReason = isRegexMatchImpossibleForOrigin(source);
    const matchesNothing = deadReason !== undefined;
    return {
      compiled: {
        pattern,
        regex,
        matchesNothing,
        matches: (origin: string) => {
          const normalized = normalizeOrigin(origin);
          return normalized !== undefined && regex.test(normalized);
        },
      },
      warning: deadReason ? { pattern, reason: deadReason } : undefined,
    };
  }

  // Wildcard subdomain origin pattern: http(s)://*.domain[:port]
  if (pattern.includes("*")) {
    const wildcardMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/\*\.([^/?#]+)(.*)$/.exec(pattern);
    if (!wildcardMatch) {
      throw new OriginPatternConfigError(
        rawPattern,
        "wildcard '*' is only supported as a leading subdomain label (e.g. https://*.example.com)",
      );
    }
    const [, schemeRaw, hostAndPort, trailing] = wildcardMatch;
    const scheme = schemeRaw!.toLowerCase();
    if (scheme !== "https" && scheme !== "http") {
      throw new OriginPatternConfigError(
        rawPattern,
        `unsupported protocol "${scheme}:" (only http: and https: are allowed)`,
      );
    }
    if (trailing && trailing.length > 0) {
      throw new OriginPatternConfigError(
        rawPattern,
        "origin pattern must not include a path, query string, or fragment",
      );
    }
    if (hostAndPort!.includes("*")) {
      throw new OriginPatternConfigError(
        rawPattern,
        "multiple wildcards are not allowed in an origin pattern",
      );
    }

    const baseOrigin = normalizeOrigin(`${scheme}://${hostAndPort}`);
    if (!baseOrigin) {
      throw new OriginPatternConfigError(
        rawPattern,
        "wildcard base host/port does not form a valid origin",
      );
    }

    const baseHost = hostAndPort!.split(":")[0]!.toLowerCase();
    // A subdomain wildcard over an IPv4 literal (e.g. https://*.127.0.0.1) is
    // syntactically structured like a host wildcard, but no valid DNS subdomain
    // of an IPv4 address exists — warn that it matches nothing in practice.
    if (IPV4_HOST_RE.test(baseHost)) {
      const neverRegex = /(?!)/;
      return {
        compiled: {
          pattern,
          regex: neverRegex,
          matchesNothing: true,
          matches: () => false,
        },
        warning: {
          pattern,
          reason: `subdomain wildcard over IPv4 address "${baseHost}" matches no valid origins`,
        },
      };
    }

    const normalizedBase = baseOrigin.replace(`${scheme}://`, "");
    const regex = new RegExp(
      `^${escapeRegex(scheme)}://[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${escapeRegex(normalizedBase)}$`,
      "i",
    );
    return {
      compiled: {
        pattern,
        regex,
        matchesNothing: false,
        matches: (origin: string) => {
          const normalized = normalizeOrigin(origin);
          return normalized !== undefined && regex.test(normalized);
        },
      },
    };
  }

  // Exact origin pattern
  const normalized = normalizeOrigin(pattern);
  if (!normalized) {
    throw new OriginPatternConfigError(
      rawPattern,
      "must be a bare http(s) origin without path, query, or fragment",
    );
  }

  const regex = new RegExp(`^${escapeRegex(normalized)}$`, "i");
  return {
    compiled: {
      pattern,
      regex,
      matchesNothing: false,
      matches: (origin: string) => normalizeOrigin(origin) === normalized,
    },
  };
}

/**
 * Validates and pre-compiles configured origin patterns at service boot so
 * malformed patterns fail startup immediately with the offending pattern name
 * instead of surfacing lazily during request handling (#548).
 */
export function validateOriginPatterns(
  rawPatterns: readonly string[],
  options: ValidateOriginPatternsOptions = {},
): ValidatedOriginPatterns {
  const patterns: CompiledOriginPattern[] = [];
  const warnings: OriginPatternWarning[] = [];

  for (const raw of rawPatterns) {
    const { compiled, warning } = compileSingleOriginPattern(raw);
    patterns.push(compiled);
    if (warning) {
      warnings.push(warning);
      options.onWarn?.(warning);
    }
  }

  return { patterns, warnings };
}

export function matchesAllowedOrigin(
  origin: string,
  patterns: readonly CompiledOriginPattern[],
): boolean {
  return patterns.some((entry) => entry.matches(origin));
}

function parseRawOriginPatternsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PERMISSION_ALLOWED_ORIGIN_PATTERNS ?? env.ALLOWED_ORIGIN_PATTERNS;
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",");
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ValidateOriginPatternsOptions = {},
): PermissionServiceRuntimeConfig {
  const configuredTtl = Number(env.PERMISSION_CACHE_TTL_MS);
  const originPermissionCacheTtlMs =
    Number.isFinite(configuredTtl) &&
    configuredTtl >= MIN_ORIGIN_PERMISSION_CACHE_TTL_MS &&
    configuredTtl <= MAX_ORIGIN_PERMISSION_CACHE_TTL_MS
      ? configuredTtl
      : DEFAULT_ORIGIN_PERMISSION_CACHE_TTL_MS;

  const rawPatterns = parseRawOriginPatternsFromEnv(env);
  const { patterns, warnings } = validateOriginPatterns(rawPatterns, options);

  return {
    originPermissionCacheTtlMs,
    allowedOriginPatterns: patterns,
    originPatternWarnings: warnings,
  };
}
