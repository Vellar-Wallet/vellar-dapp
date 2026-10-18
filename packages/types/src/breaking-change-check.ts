// Enforces the `BREAKING:` changelog comment convention for shared domain types
// in `@vellar/types` (issue #552).
//
// Any change that removes an exported type/interface, narrows a union type,
// removes an interface property, makes an optional property required, or
// incompatibly alters a property type must include an explicit
// `// BREAKING: <reason>` comment in the diff/source.

export const BREAKING_COMMENT_PATTERN = /(?:\/\/|\/\*+|\*)\s*BREAKING:\s*(.+)/;

export type BreakingViolationKind =
  | "removed_export"
  | "narrowed_union"
  | "changed_type_alias"
  | "removed_interface_property"
  | "optional_property_made_required"
  | "changed_interface_property_type";

export interface BreakingTypeViolation {
  symbol: string;
  kind: BreakingViolationKind;
  detail: string;
}

export interface BreakingChangeCheckResult {
  ok: boolean;
  hasBreakingComment: boolean;
  breakingComments: string[];
  violations: BreakingTypeViolation[];
}

export class BreakingChangeConventionError extends Error {
  readonly violations: BreakingTypeViolation[];

  constructor(violations: BreakingTypeViolation[]) {
    const summary = violations.map((v) => `${v.symbol} (${v.kind}): ${v.detail}`).join("; ");
    super(
      `Breaking changes in @vellar/types require an accompanying "BREAKING: <reason>" comment: ${summary}`,
    );
    this.name = "BreakingChangeConventionError";
    this.violations = violations;
  }
}

interface ParsedProperty {
  name: string;
  optional: boolean;
  typeText: string;
}

interface ParsedExport {
  name: string;
  kind: "type" | "interface";
  unionMembers?: Set<string>;
  rawTypeText?: string;
  properties?: Map<string, ParsedProperty>;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseUnionMembers(typeBody: string): Set<string> | undefined {
  const trimmed = normalizeWhitespace(typeBody);
  if (!trimmed.includes("|") || trimmed.includes("{") || trimmed.includes("(")) {
    return undefined;
  }
  const parts = trimmed
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  return new Set(parts);
}

function parseInterfaceProperties(body: string): Map<string, ParsedProperty> {
  const props = new Map<string, ParsedProperty>();
  let depth = 0;
  let current = "";

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "{" || ch === "(" || ch === "<" || ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "}" || ch === ")" || ch === ">" || ch === "]") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if ((ch === ";" || ch === "\n") && depth === 0) {
      const stmt = normalizeWhitespace(current);
      current = "";
      if (!stmt) continue;
      const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(\?)?\s*:\s*(.+)$/.exec(stmt);
      if (match) {
        const name = match[1]!;
        const optional = match[2] === "?";
        const typeText = normalizeWhitespace(match[3]!.replace(/;$/, ""));
        props.set(name, { name, optional, typeText });
      }
    } else {
      current += ch;
    }
  }

  const trailing = normalizeWhitespace(current);
  if (trailing) {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(\?)?\s*:\s*(.+)$/.exec(trailing);
    if (match) {
      const name = match[1]!;
      const optional = match[2] === "?";
      const typeText = normalizeWhitespace(match[3]!.replace(/;$/, ""));
      props.set(name, { name, optional, typeText });
    }
  }

  return props;
}

export function parseExportedTypes(source: string): Map<string, ParsedExport> {
  const clean = stripComments(source);
  const exports = new Map<string, ParsedExport>();

  // 1. Parse `export type Name = ...;`
  const typeRegex = /\bexport\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;]+);/g;
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = typeRegex.exec(clean)) !== null) {
    const name = typeMatch[1]!;
    const rawBody = normalizeWhitespace(typeMatch[2]!);
    const unionMembers = parseUnionMembers(rawBody);
    exports.set(name, {
      name,
      kind: "type",
      rawTypeText: rawBody,
      ...(unionMembers && { unionMembers }),
    });
  }

  // 2. Parse `export interface Name { ... }` with brace balancing
  const interfaceRegex = /\bexport\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\{/g;
  let ifaceMatch: RegExpExecArray | null;
  while ((ifaceMatch = interfaceRegex.exec(clean)) !== null) {
    const name = ifaceMatch[1]!;
    const bodyStart = ifaceMatch.index + ifaceMatch[0].length;
    let depth = 1;
    let pos = bodyStart;
    while (pos < clean.length && depth > 0) {
      const ch = clean[pos]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      pos++;
    }
    const body = clean.slice(bodyStart, Math.max(bodyStart, pos - 1));
    exports.set(name, {
      name,
      kind: "interface",
      properties: parseInterfaceProperties(body),
    });
  }

  return exports;
}

/**
 * Extract `BREAKING: <reason>` comments from a unified diff (added lines) or
 * directly from updated source text relative to previous source text.
 */
export function extractBreakingComments(
  afterSource: string,
  beforeSource?: string,
  diffText?: string,
): string[] {
  const comments: string[] = [];

  if (diffText !== undefined) {
    for (const line of diffText.split(/\r?\n/)) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const match = BREAKING_COMMENT_PATTERN.exec(line.slice(1));
      if (match?.[1]) {
        comments.push(match[1].replace(/\*+\/\s*$/, "").trim());
      }
    }
    return comments;
  }

  const beforeLines = new Set((beforeSource ?? "").split(/\r?\n/).map((l) => l.trim()));
  for (const line of afterSource.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (beforeSource !== undefined && beforeLines.has(trimmed)) continue;
    const match = BREAKING_COMMENT_PATTERN.exec(trimmed);
    if (match?.[1]) {
      comments.push(match[1].replace(/\*+\/\s*$/, "").trim());
    }
  }
  return comments;
}

/**
 * Compare `beforeSource` and `afterSource` of `@vellar/types` and flag any
 * removed or narrowed exported types/interfaces that lack an accompanying
 * `BREAKING:` comment.
 */
export function checkBreakingTypeChanges(
  beforeSource: string,
  afterSource: string,
  diffText?: string,
): BreakingChangeCheckResult {
  const beforeExports = parseExportedTypes(beforeSource);
  const afterExports = parseExportedTypes(afterSource);
  const violations: BreakingTypeViolation[] = [];

  for (const [symbol, beforeDef] of beforeExports.entries()) {
    const afterDef = afterExports.get(symbol);
    if (!afterDef || afterDef.kind !== beforeDef.kind) {
      violations.push({
        symbol,
        kind: "removed_export",
        detail: `Exported ${beforeDef.kind} "${symbol}" was removed or changed declaration kind.`,
      });
      continue;
    }

    if (beforeDef.kind === "type") {
      if (beforeDef.unionMembers && afterDef.unionMembers) {
        const removedMembers = [...beforeDef.unionMembers].filter(
          (m) => !afterDef.unionMembers!.has(m),
        );
        if (removedMembers.length > 0) {
          violations.push({
            symbol,
            kind: "narrowed_union",
            detail: `Exported union "${symbol}" removed member(s): ${removedMembers.join(", ")}.`,
          });
        }
      } else if (beforeDef.unionMembers && !afterDef.unionMembers) {
        if (!beforeDef.unionMembers.has(afterDef.rawTypeText ?? "")) {
          violations.push({
            symbol,
            kind: "changed_type_alias",
            detail: `Exported type "${symbol}" changed from union to "${afterDef.rawTypeText}".`,
          });
        } else {
          const removedMembers = [...beforeDef.unionMembers].filter(
            (m) => m !== afterDef.rawTypeText,
          );
          if (removedMembers.length > 0) {
            violations.push({
              symbol,
              kind: "narrowed_union",
              detail: `Exported union "${symbol}" narrowed to ${afterDef.rawTypeText} (removed: ${removedMembers.join(", ")}).`,
            });
          }
        }
      } else if (beforeDef.rawTypeText !== afterDef.rawTypeText) {
        violations.push({
          symbol,
          kind: "changed_type_alias",
          detail: `Exported type "${symbol}" changed from "${beforeDef.rawTypeText}" to "${afterDef.rawTypeText}".`,
        });
      }
    }

    if (beforeDef.kind === "interface" && beforeDef.properties && afterDef.properties) {
      for (const [propName, beforeProp] of beforeDef.properties.entries()) {
        const afterProp = afterDef.properties.get(propName);
        if (!afterProp) {
          violations.push({
            symbol: `${symbol}.${propName}`,
            kind: "removed_interface_property",
            detail: `Property "${propName}" was removed from exported interface "${symbol}".`,
          });
          continue;
        }
        if (beforeProp.optional && !afterProp.optional) {
          violations.push({
            symbol: `${symbol}.${propName}`,
            kind: "optional_property_made_required",
            detail: `Optional property "${propName}" on "${symbol}" was made required.`,
          });
        }
        if (beforeProp.typeText !== afterProp.typeText) {
          const beforeUnion = parseUnionMembers(beforeProp.typeText);
          const afterUnion = parseUnionMembers(afterProp.typeText);
          if (beforeUnion && afterUnion) {
            const removed = [...beforeUnion].filter((m) => !afterUnion.has(m));
            if (removed.length > 0) {
              violations.push({
                symbol: `${symbol}.${propName}`,
                kind: "changed_interface_property_type",
                detail: `Property "${symbol}.${propName}" narrowed union type (removed: ${removed.join(", ")}).`,
              });
            }
          } else {
            violations.push({
              symbol: `${symbol}.${propName}`,
              kind: "changed_interface_property_type",
              detail: `Property "${symbol}.${propName}" changed type from "${beforeProp.typeText}" to "${afterProp.typeText}".`,
            });
          }
        }
      }
    }
  }

  const breakingComments = extractBreakingComments(afterSource, beforeSource, diffText);
  const hasBreakingComment = breakingComments.length > 0;
  const ok = violations.length === 0 || hasBreakingComment;

  return {
    ok,
    hasBreakingComment,
    breakingComments,
    violations,
  };
}

/**
 * Throws `BreakingChangeConventionError` if `afterSource` introduces a
 * breaking change to any exported type in `beforeSource` without an
 * accompanying `BREAKING: <reason>` comment.
 */
export function assertBreakingChangeComment(
  beforeSource: string,
  afterSource: string,
  diffText?: string,
): BreakingChangeCheckResult {
  const result = checkBreakingTypeChanges(beforeSource, afterSource, diffText);
  if (!result.ok) {
    throw new BreakingChangeConventionError(result.violations);
  }
  return result;
}
