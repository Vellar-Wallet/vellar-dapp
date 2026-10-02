import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Landing from "../page";
import { BlobMenu } from "./nav-blob";
import { BLOB_CLOSED_PATH, BLOB_OPEN_PATH } from "./blob-paths";
import { LpNav } from "./lp-nav";
import { NAV_LINKS, NAV_SECTION_IDS, isInternal } from "./nav-links";
import { SCROLL_LOCK_EVENT } from "./scroll-lock";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

function mockMedia(matches: { reduced?: boolean; wide?: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion")
      ? !!matches.reduced
      : query.includes("min-width")
        ? !!matches.wide
        : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

const realMatchMedia = window.matchMedia;
const realIO = globalThis.IntersectionObserver;

beforeEach(() => {
  // @ts-expect-error simulate a browser without IO
  delete globalThis.IntersectionObserver;
  // Reduced motion makes every transition instant, so state is assertable
  // without waiting on animation frames.
  mockMedia({ reduced: true });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  globalThis.IntersectionObserver = realIO;
  document.body.style.overflow = "";
});

const commands = (d: string) => (d.match(/[A-Za-z]/g) ?? []).join("");

describe("blob paths", () => {
  it("share one command structure, which is what lets the shape morph", () => {
    expect(commands(BLOB_OPEN_PATH)).toBe(commands(BLOB_CLOSED_PATH));
  });

  it("start and end at the top edge so the shape hangs from the viewport", () => {
    for (const d of [BLOB_CLOSED_PATH, BLOB_OPEN_PATH]) {
      expect(d.startsWith("M0 0") || d.startsWith("M 0 0")).toBe(true);
      expect(d.trim().endsWith("Z")).toBe(true);
    }
  });
});

describe("nav links", () => {
  it("every link has a label and a short description", () => {
    for (const l of NAV_LINKS) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.desc.length).toBeGreaterThan(0);
      expect(l.desc.length).toBeLessThanOrEqual(30);
    }
  });

  it("has no duplicate destinations", () => {
    const hrefs = NAV_LINKS.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("only treats real in-app paths as internal", () => {
    expect(isInternal("/about")).toBe(true);
    expect(isInternal("/#how")).toBe(true);
    expect(isInternal("https://docs.vellar.xyz/")).toBe(false);
    expect(isInternal("//evil.example")).toBe(false);
  });

  it("never links into the wallet app", () => {
    for (const l of NAV_LINKS) expect(l.href).not.toBe("/app");
  });

  it("points every section link at an element that really exists on the landing page", () => {
    // Scroll-spy and smooth-scroll fail silently on a missing id, so a
    // renamed section would quietly break its nav link. Check the real page.
    render(<Landing />);
    expect(NAV_SECTION_IDS.length).toBeGreaterThan(0);
    for (const id of NAV_SECTION_IDS) {
      expect(document.getElementById(id), `#${id} missing from the landing page`).not.toBeNull();
    }
  });
});

describe("BlobMenu", () => {
  const renderMenu = (onNavigate = vi.fn()) =>
    render(<BlobMenu links={NAV_LINKS} activeSection={null} onNavigate={onNavigate} />);

  it("starts closed, announcing that state", () => {
    renderMenu();
    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("opens to every link, announcing the new state", () => {
    renderMenu();
    const toggle = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const names = screen.getAllByRole("link").map((a) => a.textContent);
    for (const l of NAV_LINKS) expect(names.some((n) => n?.startsWith(l.label))).toBe(true);
  });

  it("closes on Escape and hands focus back to the toggle", async () => {
    renderMenu();
    const toggle = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    await waitFor(() => expect(screen.queryAllByRole("link")).toHaveLength(0));
  });

  it("ignores other keys", () => {
    renderMenu();
    const toggle = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes when a link is chosen and passes the link and event on", () => {
    const onNavigate = vi.fn();
    renderMenu(onNavigate);
    const toggle = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("link", { name: /^docs/i }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0]![0].label).toBe("Docs");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("flips a link on keyboard focus, not only on hover", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const docs = screen.getByRole("link", { name: /^docs/i });
    expect(docs.getAttribute("data-flipped")).toBe("false");
    fireEvent.focus(docs);
    expect(docs.getAttribute("data-flipped")).toBe("true");
    fireEvent.blur(docs);
    expect(docs.getAttribute("data-flipped")).toBe("false");
  });

  it("flips a link on hover too", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const docs = screen.getByRole("link", { name: /^docs/i });
    fireEvent.mouseEnter(docs);
    expect(docs.getAttribute("data-flipped")).toBe("true");
    fireEvent.mouseLeave(docs);
    expect(docs.getAttribute("data-flipped")).toBe("false");
  });

  it("flips only the link that is hovered or focused", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.focus(screen.getByRole("link", { name: /^docs/i }));
    const flipped = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("data-flipped") === "true");
    expect(flipped).toHaveLength(1);
  });

  it("keeps the decorative description out of the link's accessible name", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const docs = screen.getByRole("link", { name: "Docs" });
    expect(docs.querySelector(".lp-flip-desc")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("marks only the section being viewed as the current location", () => {
    render(<BlobMenu links={NAV_LINKS} activeSection="bazaar" onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const current = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "location");
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toMatch(/^bazaar/i);
  });
});

describe("LpNav on a narrow screen", () => {
  const toggle = () =>
    document.querySelector<HTMLButtonElement>(".lp-nav-toggle") as HTMLButtonElement;

  it("keeps the bar's own actions: logo, star count, docs call to action", () => {
    render(<LpNav stars={28} />);
    expect(screen.getByRole("img", { name: "Vellar" })).toBeDefined();
    expect(screen.getByRole("link", { name: /28 stars/i })).toBeDefined();
    expect(screen.getByRole("link", { name: /read the docs/i }).getAttribute("href")).toBe(
      "https://docs.vellar.xyz/",
    );
  });

  it("omits the star badge rather than show a false zero when the count is unknown", () => {
    render(<LpNav stars={null} />);
    expect(screen.queryByRole("link", { name: /stars/i })).toBeNull();
    expect(screen.getByRole("link", { name: /vellar on github/i })).toBeDefined();
  });

  it("opens a full sheet with every link, locks the page and announces it", () => {
    const events: boolean[] = [];
    const listen = (e: Event) => events.push((e as CustomEvent<boolean>).detail);
    window.addEventListener(SCROLL_LOCK_EVENT, listen);

    render(<LpNav stars={1} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(events).toContain(true);
    const sheet = document.getElementById("lp-mobile-menu") as HTMLElement;
    for (const l of NAV_LINKS) {
      expect(within(sheet).getByText(l.label)).toBeDefined();
      expect(within(sheet).getByText(l.desc)).toBeDefined();
    }
    window.removeEventListener(SCROLL_LOCK_EVENT, listen);
  });

  it("gives the scroll back on Escape and returns focus to the toggle", async () => {
    const events: boolean[] = [];
    const listen = (e: Event) => events.push((e as CustomEvent<boolean>).detail);
    window.addEventListener(SCROLL_LOCK_EVENT, listen);

    render(<LpNav stars={1} />);
    fireEvent.click(toggle());
    fireEvent.keyDown(window, { key: "Escape" });

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
    expect(events.at(-1)).toBe(false);
    expect(document.activeElement).toBe(toggle());
    await waitFor(() => expect(document.getElementById("lp-mobile-menu")).toBeNull());
    window.removeEventListener(SCROLL_LOCK_EVENT, listen);
  });

  it("gives the scroll back if the nav unmounts while the sheet is open", () => {
    const { unmount } = render(<LpNav stars={1} />);
    fireEvent.click(toggle());
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes the sheet when a link is followed", async () => {
    render(<LpNav stars={1} />);
    fireEvent.click(toggle());
    const sheet = document.getElementById("lp-mobile-menu") as HTMLElement;
    fireEvent.click(within(sheet).getByRole("link", { name: /^docs/i }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
  });

  it("puts the sheet outside the bar, so a backdrop-filter cannot shrink it", () => {
    // A backdrop-filter on the scrolled bar makes it the containing block for
    // `position: fixed` descendants, which collapsed this "full-screen" sheet
    // to the height of the bar. It must stay a sibling, never a child.
    render(<LpNav stars={1} />);
    fireEvent.click(toggle());
    const sheet = document.getElementById("lp-mobile-menu") as HTMLElement;
    expect(sheet.closest(".lp-nav-outer")).toBeNull();
  });

  it("takes the paper backdrop while the sheet is open", () => {
    const { container } = render(<LpNav stars={1} />);
    const bar = container.querySelector(".lp-nav-outer") as HTMLElement;
    expect(bar.className).not.toContain("is-scrolled");
    fireEvent.click(toggle());
    expect(bar.className).toContain("is-scrolled");
  });

  it("takes the paper backdrop once the page has scrolled", () => {
    const { container } = render(<LpNav stars={1} />);
    const bar = container.querySelector(".lp-nav-outer") as HTMLElement;
    Object.defineProperty(window, "scrollY", { configurable: true, value: 120 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(bar.className).toContain("is-scrolled");
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(bar.className).not.toContain("is-scrolled");
  });
});
