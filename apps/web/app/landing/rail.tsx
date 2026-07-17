"use client";

import { useRef } from "react";

/** "Everyday wallet" carousel section: snap rail + arrow controls. */
export function EverydaySection() {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 320, behavior: "smooth" });

  return (
    <section className="sec" id="wallet" style={{ paddingTop: 20 }}>
      <div className="wrap">
        <div className="sec-head">
          <div>
            <span className="eyebrow">Everyday actions</span>
            <h2>Your everyday Stellar wallet.</h2>
          </div>
          <div className="arrows">
            <button onClick={() => scroll(-1)} aria-label="Previous">
              ‹
            </button>
            <button onClick={() => scroll(1)} aria-label="Next">
              ›
            </button>
          </div>
        </div>
        <div className="rail" ref={ref}>
          <div className="rcard">
            <div className="rc-vis">
              <span className="badge">✓ Sent</span>
            </div>
            <div className="rc-foot">
              <i>↑</i>
              <b>Send</b>
            </div>
          </div>
          <div className="rcard">
            <div className="rc-vis" style={{ alignItems: "stretch", padding: 16 }}>
              <div style={{ width: "100%" }}>
                <div className="field" style={{ margin: "0 0 8px" }}>
                  <div className="lbl">YOU SELL</div>
                  <div className="row">
                    <span className="amt" style={{ fontSize: 20 }}>
                      100
                    </span>
                    <span className="token">
                      <i></i>XLM
                    </span>
                  </div>
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <div className="lbl">YOU RECEIVE</div>
                  <div className="row">
                    <span className="amt" style={{ fontSize: 20 }}>
                      18.98
                    </span>
                    <span className="token usdc">
                      <i></i>USDC
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="rc-foot">
              <i>⇄</i>
              <b>Swap</b>
            </div>
          </div>
          <div className="rcard">
            <div className="rc-vis">
              <div className="rings"></div>
              <span className="badge">✓ Deposited</span>
            </div>
            <div className="rc-foot">
              <i>↓</i>
              <b>Deposit</b>
            </div>
          </div>
          <div className="rcard">
            <div className="rc-vis" style={{ alignItems: "stretch", padding: 16 }}>
              <div style={{ width: "100%" }}>
                <div className="rrow" style={{ border: "none", padding: "8px 0" }}>
                  <div className="ti tokrow-ti"></div>
                  <div className="rn">
                    <b>Stellar Lumens</b>
                    <span>XLM</span>
                  </div>
                </div>
                <div className="rrow" style={{ padding: "8px 0" }}>
                  <div className="ri"></div>
                  <div className="rn">
                    <b>USD Coin</b>
                    <span>USDC</span>
                  </div>
                </div>
                <div className="rrow" style={{ padding: "8px 0" }}>
                  <div className="ri"></div>
                  <div className="rn">
                    <b>yXLM</b>
                    <span>Yield</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="rc-foot">
              <i>◎</i>
              <b>Discover</b>
            </div>
          </div>
          <div className="rcard">
            <div className="rc-vis">
              <span
                className="badge"
                style={{
                  background: "var(--surface)",
                  color: "var(--signal)",
                  border: "1px solid var(--line)",
                }}
              >
                Passkey
              </span>
            </div>
            <div className="rc-foot">
              <i>⚙</i>
              <b>Set policies</b>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
