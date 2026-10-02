import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Curtain, HeroScene, ScrubScene, type ScrubRenderProps } from "./scenes";
import { Reveal } from "./reveal";
import { ProofStrip } from "./proof-strip";
import { TraceSection } from "./trace";

/** jsdom has no matchMedia. Install one that answers per query, so a test
 *  can say "reduced motion" or "narrow" independently. */
function mockMedia(matches: { reduced?: boolean; narrow?: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion")
      ? !!matches.reduced
      : query.includes("max-width")
        ? !!matches.narrow
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

afterEach(() => {
  window.matchMedia = realMatchMedia;
  globalThis.IntersectionObserver = realIO;
});

describe("Reveal", () => {
  it("fails open: with no IntersectionObserver the content is shown, not left hidden", () => {
    // @ts-expect-error simulate a browser without IO
    delete globalThis.IntersectionObserver;
    render(<Reveal>hello</Reveal>);
    expect(screen.getByText("hello").className).toContain("is-in");
  });

  it("stays hidden until the observer reports it intersecting, then reveals once", () => {
    let fire: (intersecting: boolean) => void = () => {};
    const disconnect = vi.fn();
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) {
        fire = (isIntersecting) =>
          cb([{ isIntersecting } as IntersectionObserverEntry], this as never);
      }
      observe() {}
      disconnect = disconnect;
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;

    render(<Reveal>later</Reveal>);
    const el = screen.getByText("later");
    expect(el.className).not.toContain("is-in");

    act(() => fire(false));
    expect(el.className).not.toContain("is-in");

    act(() => fire(true));
    expect(el.className).toContain("is-in");
    expect(disconnect).toHaveBeenCalled();
  });

  it("applies the spec's stagger as transition delay and duration", () => {
    // @ts-expect-error simulate a browser without IO
    delete globalThis.IntersectionObserver;
    render(
      <Reveal delay={0.4} duration={0.8}>
        timed
      </Reveal>,
    );
    const el = screen.getByText("timed");
    expect(el.style.transitionDelay).toBe("0.4s");
    expect(el.style.transitionDuration).toBe("0.8s");
  });

  it("renders as the requested element and keeps extra classes", () => {
    // @ts-expect-error simulate a browser without IO
    delete globalThis.IntersectionObserver;
    render(
      <Reveal as="h1" className="poster">
        title
      </Reveal>,
    );
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.className).toContain("poster");
    expect(h1.className).toContain("lp-reveal");
  });
});

describe("Curtain", () => {
  it("is diagonal and overlapping only when asked, and tone defaults to ink", () => {
    const { container } = render(
      <>
        <Curtain>plain</Curtain>
        <Curtain diagonal>slanted</Curtain>
        <Curtain overlap={false}>flat</Curtain>
        <Curtain tone="lime">loud</Curtain>
        <Curtain tone="tint">soft</Curtain>
      </>,
    );
    const at = (i: number) => container.children[i] as HTMLElement;
    const [plain, slanted, flat, loud] = [at(0), at(1), at(2), at(3)];
    expect(plain.className).toContain("lp-curtain--ink");
    expect(plain.className).toContain("lp-curtain--overlap");
    expect(plain.className).not.toContain("lp-curtain--diagonal");
    expect(slanted.className).toContain("lp-curtain--diagonal");
    expect(flat.className).not.toContain("lp-curtain--overlap");
    expect(loud.className).toContain("lp-curtain--lime");
    expect((container.children[4] as HTMLElement).className).toContain("lp-curtain--tint");
  });

  it('"wide" overlaps only where the scene before it pins, never as a plain overlap', () => {
    // Below 800px the trace is static, so a plain -100vh overlap slid the next
    // block up over the trace's own content and hid it.
    const { container } = render(<Curtain overlap="wide">x</Curtain>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("lp-curtain--overlap-wide");
    expect(el.className).not.toMatch(/lp-curtain--overlap(?!-)/);
  });

  it("renders identical markup whatever the reduced-motion preference (hydration-safe)", () => {
    mockMedia({ reduced: false });
    const a = render(<Curtain diagonal>x</Curtain>).container.innerHTML;
    mockMedia({ reduced: true });
    const b = render(<Curtain diagonal>x</Curtain>).container.innerHTML;
    expect(b).toBe(a);
  });
});

describe("HeroScene", () => {
  beforeEach(() => mockMedia({}));

  it("pins the hero in a sticky scene by default", () => {
    const { container } = render(
      <HeroScene>
        <p>hero</p>
      </HeroScene>,
    );
    expect(container.querySelector(".lp-scene-outer--hero")).not.toBeNull();
    expect(container.querySelector(".lp-scene-sticky")).not.toBeNull();
  });

  it("drops the sticky layer entirely under reduced motion but keeps the content", () => {
    mockMedia({ reduced: true });
    const { container } = render(
      <HeroScene>
        <p>hero</p>
      </HeroScene>,
    );
    expect(container.querySelector(".lp-scene-sticky")).toBeNull();
    expect(screen.getByText("hero")).toBeDefined();
  });
});

describe("ScrubScene", () => {
  it("is a tall pinned scene on a wide screen with motion allowed", () => {
    mockMedia({});
    const probe = vi.fn((_p: ScrubRenderProps) => <p>body</p>);
    const { container } = render(<ScrubScene id="s">{probe}</ScrubScene>);
    const section = container.querySelector("section") as HTMLElement;
    expect(section.style.height).toBe("320vh");
    expect(container.querySelector(".lp-scene-sticky")).not.toBeNull();
    expect(probe.mock.calls[0]![0].reduced).toBe(false);
  });

  it.each([
    ["reduced motion", { reduced: true }],
    ["a narrow screen", { narrow: true }],
  ])("renders statically, finished, for %s", (_name, media) => {
    mockMedia(media);
    const probe = vi.fn((_p: ScrubRenderProps) => <p>body</p>);
    const { container } = render(<ScrubScene id="s">{probe}</ScrubScene>);
    const section = container.querySelector("section") as HTMLElement;
    expect(section.style.height).toBe("");
    expect(section.className).toContain("lp-scrub--static");
    expect(container.querySelector(".lp-scene-sticky")).toBeNull();
    const props = probe.mock.calls[0]![0];
    expect(props.reduced).toBe(true);
    // pinned to the finished state, as real motion values
    expect(props.read.get()).toBe(1);
    expect(props.exit.get()).toBe(0);
  });

  it("forwards id and className so a scene keeps its scoped styling", () => {
    mockMedia({});
    const { container } = render(
      <ScrubScene id="trace" className="lp-trace">
        {() => <p>x</p>}
      </ScrubScene>,
    );
    const section = container.querySelector("section") as HTMLElement;
    expect(section.id).toBe("trace");
    expect(section.className).toContain("lp-trace");
  });
});

describe("TraceSection", () => {
  const VALUES = ["402", "0.05 USDC", "✓ valid", "✓ fee sponsored", "200 OK"];

  it("shows the whole finished request when static, with no scroll styles applied", () => {
    mockMedia({ reduced: true });
    const { container } = render(<TraceSection />);
    for (const v of VALUES) expect(screen.getByText(v)).toBeDefined();
    for (const row of Array.from(container.querySelectorAll(".lp-trace-row"))) {
      expect((row as HTMLElement).style.opacity).toBe("");
    }
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/vellar settles it/i);
  });

  it("keeps every row and the full copy in the animated version too", () => {
    mockMedia({});
    render(<TraceSection />);
    for (const v of VALUES) expect(screen.getByText(v)).toBeDefined();
    expect(screen.getByText(/the resource server returns 402/i)).toBeDefined();
  });
});

describe("ProofStrip marquee accessibility", () => {
  it("exposes each proof to assistive tech exactly once", () => {
    render(<ProofStrip />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(4);
    const text = links.map((l) => l.textContent ?? "").join(" | ");
    for (const label of [
      "Community facilitator",
      "15 verified testnet tx",
      "6 settlements, stock clients",
      "First payments settled Sept 2026",
    ]) {
      expect(text).toContain(label);
    }
  });

  it("keeps every visual clone out of the tab order", () => {
    const { container } = render(<ProofStrip />);
    const hidden = Array.from(container.querySelectorAll('a[aria-hidden="true"]'));
    expect(hidden.length).toBeGreaterThan(0);
    for (const a of hidden) expect(a.getAttribute("tabindex")).toBe("-1");
    // and nothing visible is accidentally unfocusable
    const real = Array.from(container.querySelectorAll("a:not([aria-hidden])"));
    for (const a of real) expect(a.getAttribute("tabindex")).toBeNull();
  });

  it("opens every proof in a new tab without leaking the opener", () => {
    const { container } = render(<ProofStrip />);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noreferrer");
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
    }
  });

  it("builds a loop whose halves are identical, so -50% is seamless", () => {
    const { container } = render(<ProofStrip />);
    for (const row of Array.from(container.querySelectorAll(".lp-marquee"))) {
      const cards = Array.from(row.children).map((c) => c.textContent);
      expect(cards.length % 2).toBe(0);
      const half = cards.length / 2;
      expect(cards.slice(0, half)).toEqual(cards.slice(half));
    }
  });

  it("runs the two rows in opposite directions at the spec's 20s and 25s", () => {
    const { container } = render(<ProofStrip />);
    const [fwd, rev] = Array.from(container.querySelectorAll(".lp-marquee")) as HTMLElement[];
    expect(fwd!.className).toContain("lp-marquee--forward");
    expect(fwd!.style.animationDuration).toBe("20s");
    expect(rev!.className).toContain("lp-marquee--reverse");
    expect(rev!.style.animationDuration).toBe("25s");
  });
});
