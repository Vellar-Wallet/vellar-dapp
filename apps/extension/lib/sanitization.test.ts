import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  sanitizeUrl,
  sanitizeString,
  sanitizeDAppMetadata,
} from "./sanitization";

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
      expect(sanitizeString("<img src=x onerror=alert(1)>Malicious")).toBe(
        "Malicious",
      );
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
