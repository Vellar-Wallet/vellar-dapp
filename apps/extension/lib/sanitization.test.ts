import { describe, it, expect } from "vitest";
import { escapeHtml, sanitizeUrl, sanitizeString, sanitizeDAppMetadata } from "./sanitization";

describe("input sanitization helpers (#312)", () => {
  describe("escapeHtml", () => {
    it("escapes script tags and special HTML characters", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;&#x2F;script&gt;",
      );
      expect(escapeHtml('Hello "World" & <Friends>')).toBe(
        "Hello &quot;World&quot; &amp; &lt;Friends&gt;",
      );
    });
  });

  describe("sanitizeUrl", () => {
    it("blocks javascript: and data: URIs", () => {
      expect(sanitizeUrl("javascript:alert(1)")).toBe("");
      expect(sanitizeUrl("JAVASCRIPT:alert(1)")).toBe("");
      expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
      expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("");
    });

    it("allows valid http and https URLs", () => {
      expect(sanitizeUrl("https://example.com/icon.png")).toBe(
        "https:&#x2F;&#x2F;example.com&#x2F;icon.png",
      );
    });

    it("handles undefined or null inputs", () => {
      expect(sanitizeUrl(undefined)).toBe("");
      expect(sanitizeUrl("")).toBe("");
    });
  });

  describe("sanitizeString", () => {
    it("strips HTML tags and removes control characters", () => {
      expect(sanitizeString("<img src=x onerror=alert(1)>Malicious")).toBe("Malicious");
      expect(sanitizeString("Clean\x00Name")).toBe("CleanName");
    });

    it("truncates string to specified max length", () => {
      const longInput = "a".repeat(200);
      expect(sanitizeString(longInput, 50).length).toBe(50);
    });

    it("handles non-string or malformed inputs safely", () => {
      expect(sanitizeString(12345)).toBe("12345");
      expect(sanitizeString({ invalid: "object" })).toBe("[object Object]");
      expect(sanitizeString(null)).toBe("");
      expect(sanitizeString(undefined)).toBe("");
    });

    // #578: a dApp-supplied memo (or any other free-text field) containing
    // control characters, which — unsanitized — could affect terminal/log
    // rendering or visually spoof the approval screen.
    describe("control characters in a dApp-supplied memo field", () => {
      it("strips null bytes and other non-printable C0 control characters", () => {
        // \x00 null byte, \x07 bell, \x1b ESC (start of an ANSI escape code).
        const memo = "Pay\x00invoice\x07 #42\x1b[31m";
        expect(sanitizeString(memo)).toBe("Payinvoice #42[31m");
      });

      it("strips a full ANSI escape sequence rather than just its ESC byte", () => {
        // \x1b[31m is "set foreground red" — a terminal/log-spoofing vector if
        // this memo is ever echoed to a console or log viewer.
        const memo = "\x1b[31mDANGER\x1b[0m normal text";
        const result = sanitizeString(memo);
        expect(result).not.toContain("\x1b");
        expect(result).toContain("DANGER");
        expect(result).toContain("normal text");
      });

      it("strips DEL (0x7f) and preserves space/tab/newline", () => {
        const memo = "line one\x7f\nline two\ttabbed";
        const result = sanitizeString(memo);
        expect(result).not.toContain("\x7f");
        expect(result).toBe("line one\nline two\ttabbed");
      });

      it("strips Unicode bidirectional-text override characters (UI-spoofing vector)", () => {
        // U+202E (RIGHT-TO-LEFT OVERRIDE) + U+202C (POP DIRECTIONAL FORMATTING)
        // can visually reorder the surrounding text on the approval screen —
        // e.g. making "gpj.exe" render as "exe.jpg" — without being caught by
        // the C0/C1 control-character range, since bidi overrides are
        // themselves printable Unicode characters.
        const memo = "Invoice ‮exe.gpj‬.pdf";
        const result = sanitizeString(memo);
        expect(result).not.toContain("‮");
        expect(result).not.toContain("‬");
        expect(result).toBe("Invoice exe.gpj.pdf");
      });

      it("strips Unicode bidirectional isolate characters alongside overrides", () => {
        // U+2066-U+2069 (LRI/RLI/FSI/PDI) are the isolate counterparts to the
        // override characters above and carry the same spoofing risk.
        const memo = "⁦hidden⁩ memo";
        const result = sanitizeString(memo);
        expect(result).not.toMatch(/[⁦-⁩]/);
        expect(result).toBe("hidden memo");
      });
    });
  });

  describe("sanitizeDAppMetadata", () => {
    it("sanitizes full dApp metadata payload containing script injection attempts", () => {
      const payload = {
        name: "<script>eval('bad')</script>DApp Exchange",
        description: "Best DEX <iframe src='http://evil.com'></iframe> for tokens",
        iconUrl: "javascript:void(0)",
        origin: "https://dapp.example.com",
      };

      const result = sanitizeDAppMetadata(payload);

      expect(result.name).not.toContain("<script>");
      expect(result.name).toContain("DApp Exchange");
      expect(result.description).not.toContain("<iframe");
      expect(result.description).toContain("Best DEX  for tokens");
      expect(result.iconUrl).toBe("");
      expect(result.origin).toBe("https:&#x2F;&#x2F;dapp.example.com");
    });

    it("provides fallback for missing or empty name", () => {
      const result = sanitizeDAppMetadata({ name: "" });
      expect(result.name).toBe("Unknown dApp");
    });
  });
});
