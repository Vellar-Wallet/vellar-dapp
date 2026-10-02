import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DragRail } from "./drag-rail";
import { Playground } from "./playground";
import { WaveEdge } from "./wave-edge";
import { useMediaQuery } from "./use-media";

function mockMedia(matches: { reduced?: boolean; fine?: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion")
      ? !!matches.reduced
      : query.includes("pointer: fine")
        ? !!matches.fine
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

/** jsdom has no PointerEvent, so `fireEvent.pointerDown` builds a plain
 *  Event with no `pointerType` or `button`, and a handler that checks them
 *  bails out the same way for every input. Without this shim a test about
 *  "only a mouse drags" cannot tell the right code from the wrong code. */
class FakePointerEvent extends MouseEvent {
  pointerType: string;
  pointerId: number;
  constructor(
    type: string,
    init: MouseEventInit & { pointerType?: string; pointerId?: number } = {},
  ) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.pointerType = init.pointerType ?? "mouse";
    this.pointerId = init.pointerId ?? 1;
  }
}

const realMatchMedia = window.matchMedia;
const realPointerEvent = (window as unknown as { PointerEvent?: unknown }).PointerEvent;
const realSetCapture = Element.prototype.setPointerCapture;
const realIO = globalThis.IntersectionObserver;
const realScrollBy = Element.prototype.scrollBy;

beforeEach(() => {
  // jsdom has neither; Reveal fails open without IO, the rail needs scrollBy.
  // @ts-expect-error simulate a browser without IO
  delete globalThis.IntersectionObserver;
  Element.prototype.scrollBy = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  (window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
  mockMedia({});
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  globalThis.IntersectionObserver = realIO;
  Element.prototype.scrollBy = realScrollBy;
  Element.prototype.setPointerCapture = realSetCapture;
  (window as unknown as { PointerEvent?: unknown }).PointerEvent = realPointerEvent;
});

describe("useMediaQuery", () => {
  function Probe() {
    return <span>{useMediaQuery("(prefers-reduced-motion: reduce)") ? "yes" : "no"}</span>;
  }

  it("reports the real answer on the client", () => {
    mockMedia({ reduced: true });
    render(<Probe />);
    expect(screen.getByText("yes")).toBeDefined();
  });

  it("never lets the server output depend on the media query (hydration-safe)", () => {
    // The user prefers reduced motion, but the server cannot know that. If the
    // server HTML reflected the preference, the client's first render would
    // differ from it and React would discard and rebuild the tree.
    mockMedia({ reduced: true });
    expect(renderToString(<Probe />)).toContain("no");
    expect(renderToString(<Probe />)).not.toContain("yes");
  });
});

describe("Playground", () => {
  it("keeps every lab, its copy and the example card", () => {
    render(<Playground />);
    for (const title of ["Learn the flow", "Break payments", "The Bazaar, live", "Quest mode"]) {
      expect(screen.getByRole("heading", { name: title })).toBeDefined();
    }
    expect(screen.getByText(/five deliberate corruptions of a real signed payment/i)).toBeDefined();
    expect(screen.getByText(/a five-level challenge track/i)).toBeDefined();
    // the example that sat beside the labs is now the rail's last item
    expect(screen.getByText(/break payments, live · example/i)).toBeDefined();
    expect(screen.getByText("✗ refused")).toBeDefined();
    expect(screen.getByText(/nothing charged, that's the point/i)).toBeDefined();
  });

  it("numbers the labs in order", () => {
    render(<Playground />);
    for (const n of ["01", "02", "03", "04"]) expect(screen.getByText(`Lab ${n}`)).toBeDefined();
  });

  it("still links the call to action to the playground", () => {
    render(<Playground />);
    const cta = screen.getByRole("link", { name: /open the playground/i });
    expect(cta.getAttribute("href")).toBe("https://playground.vellar.xyz/");
  });

  it("is a labelled, keyboard-focusable region", () => {
    render(<Playground />);
    const region = screen.getByRole("region", { name: "Playground labs" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});

describe("DragRail", () => {
  it("starts at the left edge with Previous disabled", () => {
    render(
      <DragRail label="rail">
        <div>a</div>
      </DragRail>,
    );
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("scrolls the track when Next is pressed", () => {
    render(
      <DragRail label="rail">
        <div>a</div>
      </DragRail>,
    );
    // jsdom lays nothing out, so scrollWidth is 0 and both edges read as
    // reached; force the track to look scrollable.
    const track = screen.getByRole("region", { name: "rail" });
    Object.defineProperty(track, "scrollWidth", { configurable: true, value: 2000 });
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 500 });
    fireEvent.scroll(track);
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(Element.prototype.scrollBy).toHaveBeenCalledWith({ left: 400, behavior: "smooth" });
  });

  it("scrolls instantly, not smoothly, under reduced motion", () => {
    mockMedia({ reduced: true });
    render(
      <DragRail label="rail">
        <div>a</div>
      </DragRail>,
    );
    const track = screen.getByRole("region", { name: "rail" });
    Object.defineProperty(track, "scrollWidth", { configurable: true, value: 2000 });
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 500 });
    fireEvent.scroll(track);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(Element.prototype.scrollBy).toHaveBeenCalledWith({ left: 400, behavior: "auto" });
  });

  it("shows the drag cursor only for a fine pointer with motion allowed", () => {
    const cursor = (c: HTMLElement) => c.querySelector(".lp-rail-cursor");

    mockMedia({ fine: true });
    expect(
      cursor(
        render(
          <DragRail label="r">
            <i />
          </DragRail>,
        ).container,
      ),
    ).not.toBeNull();

    mockMedia({ fine: false });
    expect(
      cursor(
        render(
          <DragRail label="r">
            <i />
          </DragRail>,
        ).container,
      ),
    ).toBeNull();

    mockMedia({ fine: true, reduced: true });
    expect(
      cursor(
        render(
          <DragRail label="r">
            <i />
          </DragRail>,
        ).container,
      ),
    ).toBeNull();
  });

  it("keeps the cursor out of the accessibility tree", () => {
    mockMedia({ fine: true });
    const { container } = render(
      <DragRail label="r">
        <i />
      </DragRail>,
    );
    expect(container.querySelector(".lp-rail-cursor")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("a mouse press starts a drag and release ends it", () => {
    const { container } = render(
      <DragRail label="r">
        <i />
      </DragRail>,
    );
    const track = screen.getByRole("region", { name: "r" });
    fireEvent.pointerDown(track, { pointerType: "mouse", button: 0, clientX: 100 });
    expect(container.querySelector(".is-dragging")).not.toBeNull();
    fireEvent.pointerUp(track, { pointerType: "mouse", button: 0 });
    expect(container.querySelector(".is-dragging")).toBeNull();
  });

  it("a mouse drag moves the track opposite to the pointer", () => {
    render(
      <DragRail label="r">
        <i />
      </DragRail>,
    );
    const track = screen.getByRole("region", { name: "r" });
    track.scrollLeft = 300;
    fireEvent.pointerDown(track, { pointerType: "mouse", button: 0, clientX: 500 });
    fireEvent.pointerMove(track, { pointerType: "mouse", clientX: 450 });
    // pointer moved 50px left, so the content follows: scrollLeft grows by 50
    expect(track.scrollLeft).toBe(350);
  });

  it.each([
    ["a touch", { pointerType: "touch", button: 0 }],
    ["a pen", { pointerType: "pen", button: 0 }],
    ["a right-click", { pointerType: "mouse", button: 2 }],
  ])("%s does not start a drag, so native scrolling is left alone", (_name, init) => {
    const { container } = render(
      <DragRail label="r">
        <i />
      </DragRail>,
    );
    const track = screen.getByRole("region", { name: "r" });
    fireEvent.pointerDown(track, { ...init, clientX: 100 });
    expect(container.querySelector(".is-dragging")).toBeNull();
  });
});

describe("WaveEdge", () => {
  it("is decorative and takes its colour from the ground it hangs on", () => {
    const { container } = render(<WaveEdge />);
    const wrap = container.querySelector(".lp-wave");
    expect(wrap?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("draws one seamless period every quarter of its path", () => {
    const { container } = render(<WaveEdge />);
    // 400% wide and a -25% translate only loop cleanly if the path really
    // spans 2880 units and repeats every 720.
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 2880 200");
    expect(container.querySelector("path")?.getAttribute("d")).toContain("2880 100");
  });
});
