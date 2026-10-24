import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MIN_MODULE_PX, MIN_QR_SIZE, QrCode, QUIET_ZONE } from "./qr-code";

const SAMPLE_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("QrCode component", () => {
  it("renders at the default size of 208px", () => {
    render(<QrCode value={SAMPLE_ADDR} label="Wallet address" />);

    const svg = screen.getByTestId("receive-qr");
    expect(svg.getAttribute("width")).toBe("208");
    expect(svg.getAttribute("height")).toBe("208");
    expect(svg.getAttribute("aria-label")).toBe("Wallet address");
    expect(svg.getAttribute("data-qr-payload")).toBe(SAMPLE_ADDR);
  });

  it("renders at its documented minimum supported size and meets module-size threshold", () => {
    render(<QrCode value={SAMPLE_ADDR} label="Min size QR" size={MIN_QR_SIZE} />);

    const svg = screen.getByTestId("receive-qr");
    expect(Number(svg.getAttribute("width"))).toBe(MIN_QR_SIZE);
    expect(Number(svg.getAttribute("height"))).toBe(MIN_QR_SIZE);

    // Extract extent from viewBox="0 0 <extent> <extent>"
    const viewBox = svg.getAttribute("viewBox");
    expect(viewBox).toBeDefined();
    const [, , , extentStr] = (viewBox ?? "").split(" ");
    const extent = Number(extentStr);

    // Assert rendered module size meets minimum pixel threshold for reliable scanning
    const modulePixelSize = MIN_QR_SIZE / extent;
    expect(modulePixelSize).toBeGreaterThanOrEqual(MIN_MODULE_PX);
  });

  it("covers a payload requiring the highest QR version (version 40) at minimum size", () => {
    // 1600 bytes in byte mode with ECC level M requires QR version 40 (177 modules)
    const longPayload = "A".repeat(1600);
    render(<QrCode value={longPayload} label="Max version QR" size={MIN_QR_SIZE} />);

    const svg = screen.getByTestId("receive-qr");
    const viewBox = svg.getAttribute("viewBox");
    const [, , , extentStr] = (viewBox ?? "").split(" ");
    const extent = Number(extentStr);

    // Version 40 has 177 modules. With QUIET_ZONE (4 each side), extent is 177 + 8 = 185
    const version40Modules = 177;
    const expectedExtent = version40Modules + QUIET_ZONE * 2;
    expect(extent).toBe(expectedExtent);

    // At MIN_QR_SIZE (185px), each module is exactly 1px, satisfying the minimum threshold
    const modulePixelSize = MIN_QR_SIZE / extent;
    expect(modulePixelSize).toBeGreaterThanOrEqual(MIN_MODULE_PX);
    expect(modulePixelSize).toBe(1);
  });

  it("rejects non-ASCII and empty payloads", () => {
    expect(() => render(<QrCode value="" label="empty" />)).toThrow();
    expect(() => render(<QrCode value="pay €5" label="unicode" />)).toThrow();
  });
});
