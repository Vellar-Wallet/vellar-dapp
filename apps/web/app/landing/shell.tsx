import type { ReactNode } from "react";
import { LandingMotion } from "./motion";
import { LpNavWithStars } from "./lp-nav-stars";
import { LpFooter } from "./footer";
import "./landing.css";

/** Page chrome for every .lp marketing page: scope class, motion
 *  runtime, nav and footer. Pages compose their sections inside.
 *
 *  Deliberately SYNCHRONOUS. The nav needs a server-fetched star count, but
 *  making this component async would make every page that renders it async
 *  too — and Next's own testing guide says async Server Components are not
 *  supported by unit-test tooling ("we recommend using End-to-End Testing
 *  over Unit Testing for async components"), which broke app/page.test.tsx.
 *  The await is isolated in LpNavWithStars instead, so the page tree stays
 *  synchronously renderable. */
export function LpShell({ children }: { children: ReactNode }) {
  return (
    <div className="lp">
      <LandingMotion />
      <LpNavWithStars />
      {children}
      <LpFooter />
    </div>
  );
}
