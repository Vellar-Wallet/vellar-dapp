// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { qrMatrix } from "@/lib/qr";
import { MIN_QR_MODULE_PX, MIN_QR_SIZE, QUIET_ZONE, QrCode, qrModuleSizePx } from "./qr-code";

const STELLAR_G_ADDRESS = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const SOROBAN_C_ADDRESS = "CCJCTOZFKPNT72377BNKD23322332233223322332233223322332327";
const SEP7_PAYMENT_URI = `web+stellar:pay?destination=${STELLAR_G_ADDRESS}&amount=25.5&memo=invoice-576`;

describe("QrCode smallest supported container size (#576)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a 56-character Stellar address at MIN_QR_SIZE with valid viewBox, quiet zone, and scannable module size", () => {
    render(<QrCode value={STELLAR_G_ADDRESS} label="Wallet address QR code" size={MIN_QR_SIZE} />);

    const svg = screen.getByRole("img", { name: "Wallet address QR code" });
    expect(svg.getAttribute("width")).toBe(String(MIN_QR_SIZE));
    expect(svg.getAttribute("height")).toBe(String(MIN_QR_SIZE));
    expect(svg.getAttribute("data-qr-payload")).toBe(STELLAR_G_ADDRESS);
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");

    const matrix = qrMatrix(STELLAR_G_ADDRESS);
    const expectedExtent = matrix.length + QUIET_ZONE * 2;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${expectedExtent} ${expectedExtent}`);

    const backgroundRect = svg.querySelector("rect");
    expect(backgroundRect).not.toBeNull();
    expect(backgroundRect?.getAttribute("width")).toBe(String(expectedExtent));
    expect(backgroundRect?.getAttribute("height")).toBe(String(expectedExtent));

    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    const d = path?.getAttribute("d") ?? "";
    expect(d.length).toBeGreaterThan(0);
    // Quiet zone offsets the top-left finder pattern to (QUIET_ZONE, QUIET_ZONE).
    expect(d.startsWith(`M${QUIET_ZONE} ${QUIET_ZONE}h1v1h-1z`)).toBe(true);

    const modulePx = qrModuleSizePx(expectedExtent, MIN_QR_SIZE);
    expect(modulePx).toBeGreaterThanOrEqual(MIN_QR_MODULE_PX);
  });

  it("maintains scannable module dimensions at MIN_QR_SIZE for Soroban C... addresses and SEP-7 payment URIs", () => {
    const { rerender } = render(
      <QrCode value={SOROBAN_C_ADDRESS} label="Contract address QR code" size={MIN_QR_SIZE} />,
    );

    const contractSvg = screen.getByRole("img", {
      name: "Contract address QR code",
    });
    const contractExtent = qrMatrix(SOROBAN_C_ADDRESS).length + QUIET_ZONE * 2;
    expect(contractSvg.getAttribute("viewBox")).toBe(`0 0 ${contractExtent} ${contractExtent}`);
    expect(qrModuleSizePx(contractExtent, MIN_QR_SIZE)).toBeGreaterThanOrEqual(MIN_QR_MODULE_PX);

    rerender(
      <QrCode value={SEP7_PAYMENT_URI} label="SEP-7 payment request QR code" size={MIN_QR_SIZE} />,
    );

    const sep7Svg = screen.getByRole("img", {
      name: "SEP-7 payment request QR code",
    });
    const sep7Extent = qrMatrix(SEP7_PAYMENT_URI).length + QUIET_ZONE * 2;
    expect(sep7Svg.getAttribute("width")).toBe(String(MIN_QR_SIZE));
    expect(sep7Svg.getAttribute("height")).toBe(String(MIN_QR_SIZE));
    expect(sep7Svg.getAttribute("viewBox")).toBe(`0 0 ${sep7Extent} ${sep7Extent}`);
    expect(qrModuleSizePx(sep7Extent, MIN_QR_SIZE)).toBeGreaterThanOrEqual(MIN_QR_MODULE_PX);
  });

  it("clamps container sizes smaller than MIN_QR_SIZE so modules never shrink below the scannable threshold", () => {
    render(<QrCode value={STELLAR_G_ADDRESS} label="Clamped small QR code" size={64} />);

    const svg = screen.getByRole("img", { name: "Clamped small QR code" });
    expect(svg.getAttribute("width")).toBe(String(MIN_QR_SIZE));
    expect(svg.getAttribute("height")).toBe(String(MIN_QR_SIZE));
  });
});
