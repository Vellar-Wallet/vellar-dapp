import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChevronIcon, CopyIcon } from "./icons";

// Issue #786: these icons are shared with the extension popup, where the
// toolbar uses them at 16px. Pin the geometry and the rendered markup so a
// future stroke/path change cannot silently make them illegible at that size.

describe("shared icons at the 16px extension toolbar size (issue #786)", () => {
  it("keeps CopyIcon geometry and markup stable", () => {
    const { container } = render(<CopyIcon size={16} />);
    const svg = container.querySelector("svg")!;

    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("rect")?.getAttribute("rx")).toBe("2");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(
      "M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1",
    );
    expect(svg.outerHTML).toMatchInlineSnapshot(
      `"<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>"`,
    );
  });

  it("keeps ChevronIcon geometry and orientation stable", () => {
    const left = render(<ChevronIcon size={16} dir="left" />);
    const leftSvg = left.container.querySelector("svg")!;

    expect(leftSvg.getAttribute("width")).toBe("16");
    expect(leftSvg.getAttribute("height")).toBe("16");
    expect(leftSvg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(leftSvg.getAttribute("stroke-width")).toBe("2.5");
    expect(leftSvg.querySelector("path")?.getAttribute("d")).toBe("M15 5l-7 7 7 7");
    expect(leftSvg.outerHTML).toMatchInlineSnapshot(
      `"<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>"`,
    );

    left.unmount();

    const right = render(<ChevronIcon size={16} dir="right" />);
    const rightSvg = right.container.querySelector("svg")!;
    expect(rightSvg.outerHTML).toMatchInlineSnapshot(
      `"<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="rotate: 180deg;"><path d="M15 5l-7 7 7 7"></path></svg>"`,
    );
    expect(rightSvg.outerHTML).not.toBe(leftSvg.outerHTML);
  });
});
