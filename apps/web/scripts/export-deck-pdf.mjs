/**
 * Exports a deck route to PDF using the Chrome already installed on this
 * machine (channel: "chrome"), so nothing extra is downloaded.
 *
 * The deck mounts one slide at a time, so a plain page.pdf() would capture only
 * the first. This drives the same print path the Download PDF button uses:
 * dispatch beforeprint so every slide mounts, then let the print stylesheet lay
 * them out one per landscape page. Real text, so the PDF stays searchable and
 * the contact links stay clickable.
 *
 *   node scripts/export-deck-pdf.mjs [route] [outfile]
 */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const route = process.argv[2] ?? "lava";
const outFile = resolve(process.argv[3] ?? `${route}-deck.pdf`);
const baseUrl = process.env.DECK_URL ?? "https://www.vellar.xyz";
const url = `${baseUrl}/${route}`;

const WIDTH = 1600;
const HEIGHT = 900;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

console.log(`→ ${url}`);
const res = await page.goto(url, { waitUntil: "networkidle" });
if (!res?.ok()) throw new Error(`${url} returned ${res?.status()}`);

const total = await page.evaluate(() => {
  const m = document.querySelector(".deck-pagecount")?.textContent?.match(/\/\s*(\d+)/);
  return m ? Number(m[1]) : 0;
});
if (!total) throw new Error("Could not read the slide count from .deck-pagecount");
console.log(`  ${total} slides`);

// Mount every slide the way the Download PDF button does.
await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
await page.waitForFunction(
  (n) => document.querySelectorAll(".deck-slide").length === n,
  total,
  { timeout: 10_000 },
);
await page.waitForTimeout(1200); // fonts + images

await mkdir(dirname(outFile), { recursive: true });
// NOTE: `landscape: true` rotates the explicit width/height, turning a 1600x900
// page into 900x1600. The dimensions below are already landscape, so the flag
// must stay off.
await page.pdf({
  path: outFile,
  width: `${WIDTH}px`,
  height: `${HEIGHT}px`,
  printBackground: true,
  preferCSSPageSize: false,
  margin: { top: "0", right: "0", bottom: "0", left: "0" },
  pageRanges: `1-${total}`,
});

await browser.close();
console.log(`✓ ${outFile}`);
