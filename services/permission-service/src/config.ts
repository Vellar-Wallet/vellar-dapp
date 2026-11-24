import vm from "node:vm";

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
  let compiled: RegExp;
  try {
    compiled = new RegExp(source);
  } catch (err) {
    throw new OriginPatternError(
      `invalid origin pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`,
      pattern,
    );
  }
  // Syntactically valid is not the same as safe (#840): a pattern can compile
  // fine and still backtrack catastrophically against a crafted Origin header.
  assertNoCatastrophicBacktracking(pattern, source, compiled);
  return compiled;
}

/** Longest origin string ever matched against a pattern. A real Origin is
 * scheme + `://` + host (≤ 253) + `:port`, far below this. Longer inputs are
 * refused before matching, which also bounds the boot-time ReDoS probe below. */
export const MAX_ORIGIN_LENGTH = 512;

/** At most this many unbounded quantifiers (`*` wildcards, `+`, `{n,}`) per
 * pattern. Each one is an independent `.*`-style split point, so k of them
 * cost O(n^k) on a near-miss input: 2 is ~20 ms at MAX_ORIGIN_LENGTH, 3 is
 * already ~1 s. `https://*.*.example.com` (2) stays allowed. */
export const MAX_UNBOUNDED_QUANTIFIERS = 2;

/** Wall-clock budget for one probe match at boot. A safe pattern finishes in
 * well under a millisecond; a catastrophic one never finishes at all. */
const REDOS_PROBE_TIMEOUT_MS = 100;

/**
 * Rejects patterns whose shape is a known catastrophic-backtracking (ReDoS)
 * class, then backstops that static scan with a time-boxed probe against
 * adversarial near-miss inputs. Throws `OriginPatternError` naming the pattern.
 *
 * Static classes (refused regardless of timing, so the result does not depend
 * on how fast the boot host is):
 *  - nested quantifiers: a repeated group that itself contains a repeat,
 *    e.g. `(a+)+`, `(.*)*`, `(\w+\.)*` — exponential.
 *  - quantified alternation: `(a|a)+`, `(a|ab)*` — overlapping branches are
 *    exponential; telling overlapping from disjoint branches is not worth the
 *    risk in an origin allowlist, so any repeated alternation is refused.
 *  - backreferences (`\1`…): matching with them is NP-hard in general.
 *  - more than MAX_UNBOUNDED_QUANTIFIERS unbounded quantifiers — polynomial
 *    blow-up that is still enough to stall a request.
 */
function assertNoCatastrophicBacktracking(pattern: string, source: string, compiled: RegExp): void {
  const reject = (why: string): never => {
    throw new OriginPatternError(
      `unsafe origin pattern ${JSON.stringify(pattern)}: ${why} (catastrophic backtracking / ReDoS risk)`,
      pattern,
    );
  };

  // Per open group: does its body repeat anything / contain alternation?
  const stack: Array<{ repeats: boolean; alternates: boolean }> = [
    { repeats: false, alternates: false },
  ];
  let unbounded = 0;
  // What the next quantifier would apply to.
  let last: { kind: "atom" } | { kind: "group"; repeats: boolean; alternates: boolean } | undefined;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      const next = source[i + 1] ?? "";
      if (/[1-9]/.test(next)) reject("backreferences are not allowed");
      i++;
      last = { kind: "atom" };
      continue;
    }
    if (ch === "[") {
      // Skip the character class (one atom); `]` right after `[` / `[^` is literal.
      let j = i + 1;
      if (source[j] === "^") j++;
      if (source[j] === "]") j++;
      while (j < source.length && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
      i = j;
      last = { kind: "atom" };
      continue;
    }
    if (ch === "(") {
      stack.push({ repeats: false, alternates: false });
      // Skip a group prefix such as `?:`, `?=`, `?!`, `?<=`, `?<name>`.
      if (source[i + 1] === "?") {
        i++;
        if (source[i + 1] === "<" && source[i + 2] !== "=" && source[i + 2] !== "!") {
          const close = source.indexOf(">", i);
          i = close === -1 ? i : close;
        } else if (source[i + 1] === "<") {
          i += 2;
        } else {
          i++;
        }
      }
      last = undefined;
      continue;
    }
    if (ch === ")") {
      const group = stack.length > 1 ? stack.pop()! : { repeats: false, alternates: false };
      // A group's repeats bubble up: `((a+))+` is still nested.
      if (group.repeats) stack[stack.length - 1]!.repeats = true;
      last = { kind: "group", ...group };
      continue;
    }
    if (ch === "|") {
      stack[stack.length - 1]!.alternates = true;
      last = undefined;
      continue;
    }

    let repeating = false;
    let isUnbounded = false;
    if (ch === "*" || ch === "+") {
      repeating = true;
      isUnbounded = true;
    } else if (ch === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
        repeating = max > 1;
        isUnbounded = max === Infinity;
        i += m[0].length - 1;
      } else {
        last = { kind: "atom" }; // a literal `{`
        continue;
      }
    } else if (ch === "?") {
      // `?` (optional) or a lazy modifier after another quantifier: no repeat.
      continue;
    } else {
      last = { kind: "atom" };
      continue;
    }

    if (repeating && last?.kind === "group") {
      if (last.repeats) reject("nested quantifier (a repeated group that itself repeats)");
      if (last.alternates) reject("quantified alternation (a repeated group containing `|`)");
    }
    if (repeating) stack[stack.length - 1]!.repeats = true;
    if (isUnbounded && ++unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
      reject(`more than ${MAX_UNBOUNDED_QUANTIFIERS} unbounded wildcards/quantifiers`);
    }
    last = { kind: "atom" };
  }

  // Dynamic backstop for anything the scan does not model: match the pattern
  // against near-miss inputs (a run of each literal character, then a byte the
  // pattern cannot end on) at the longest length runtime matching allows. V8's
  // regex engine honours vm's timeout, so a runaway match is interrupted here
  // instead of hanging boot.
  const alphabet = new Set(["a", ".", "-", "/", ":", "0"]);
  for (const c of pattern.replace(/[\\*()[\]{}|?+^$]/g, "")) alphabet.add(c);
  const prefix = pattern.split("*")[0]!.replace(/[\\()[\]{}|?+^$]/g, "");
  const sandbox: { re: RegExp; s: string } = { re: compiled, s: "" };
  const context = vm.createContext(sandbox);
  const probeScript = new vm.Script("re.test(s)");
  for (const c of alphabet) {
    for (const probe of [
      prefix + c.repeat(Math.max(0, MAX_ORIGIN_LENGTH - prefix.length - 1)) + "\u0000",
      c.repeat(MAX_ORIGIN_LENGTH - 1) + "\u0000",
    ]) {
      try {
        sandbox.s = probe;
        probeScript.runInContext(context, { timeout: REDOS_PROBE_TIMEOUT_MS });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
          reject(
            `matching a crafted ${probe.length}-char input exceeded ${REDOS_PROBE_TIMEOUT_MS} ms`,
          );
        }
        throw err;
      }
    }
  }
}

/**
 * Runtime matcher for a pattern compiled by `compileOriginPattern`. Fail-closed:
 * an origin longer than MAX_ORIGIN_LENGTH is refused without being matched,
 * keeping attacker-supplied input inside the bound the boot probe verified.
 */
export function matchesOriginPattern(compiled: RegExp, origin: string): boolean {
  if (origin.length > MAX_ORIGIN_LENGTH) return false;
  return compiled.test(origin);
}

/**
 * Validates every configured origin pattern at boot.
 *
 * - A pattern that cannot be compiled (invalid regex/glob syntax) throws
 *   `OriginPatternError` and fails boot, naming the pattern.
 * - A pattern that compiles but is a catastrophic-backtracking (ReDoS) risk
 *   also throws `OriginPatternError` and fails boot (#840).
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
