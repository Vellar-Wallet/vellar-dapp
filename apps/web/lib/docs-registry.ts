// Client-safe docs registry — pure data, no Node APIs, so it can be imported by
// both server and client components (the sidebar nav uses it). File reading
// lives in ./docs (server-only).

export interface DocPage {
  slug: string;
  title: string;
  /** Short label for the sidebar (defaults to title). */
  nav: string;
}

// Ordered table of contents — drives the sidebar and next/prev.
export const DOC_PAGES: DocPage[] = [
  { slug: "overview", title: "Overview", nav: "Overview" },
  { slug: "getting-started", title: "Getting Started", nav: "Getting Started" },
  { slug: "architecture", title: "Architecture", nav: "Architecture" },
  { slug: "api-reference", title: "API Reference", nav: "API Reference" },
  { slug: "core-flows", title: "Core Flows", nav: "Core Flows" },
  { slug: "security-model", title: "Security Model", nav: "Security Model" },
  { slug: "policy-contract", title: "Policy Contract", nav: "Policy Contract" },
];

export function getDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((p) => p.slug === slug);
}
