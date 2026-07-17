"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Light/dark theme (docs/decisions.md UI overhaul). Persisted to localStorage
// and applied to <html data-theme> — the pre-paint script in layout.tsx sets
// it before first render to avoid a flash.

export type Theme = "light" | "dark";
const STORAGE_KEY = "vela.theme";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "dark",
  toggle: () => {},
});

/** Inline, runs before paint — keep in sync with ThemeProvider defaults. */
export const themeInitScript = `
try {
  var t = localStorage.getItem("${STORAGE_KEY}") || "dark";
  document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "dark";
    setTheme(stored);
    document.documentElement.setAttribute("data-theme", stored);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Non-persistent is fine; the attribute still applies for this session.
      }
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
