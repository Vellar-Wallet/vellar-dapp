"use client";

import { useState } from "react";

// Shows the persona photo (public/about.jpg); falls back to a styled initials
// placeholder instead of a broken image if the file is missing.
export function PersonaImage() {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="persona-placeholder" aria-label="David Ejere">
        <span>DE</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/about.jpg" alt="David Ejere" onError={() => setFailed(true)} />
  );
}
