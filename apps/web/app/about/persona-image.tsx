"use client";

import { useState } from "react";

// Shows the persona photo (public/persona.jpg) once it's uploaded; until then,
// falls back to a styled initials placeholder instead of a broken image.
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
    <img src="/persona.jpg" alt="David Ejere" onError={() => setFailed(true)} />
  );
}
