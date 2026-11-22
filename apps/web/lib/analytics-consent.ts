export const ANALYTICS_CONSENT_STORAGE_KEY = "vellar.analytics.consent";

export type AnalyticsConsentState = "granted" | "denied" | "unset";

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getAnalyticsConsent(): AnalyticsConsentState {
  const storage = getStorage();
  if (!storage) return "unset";
  try {
    const value = storage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    if (value === "granted" || value === "denied") return value;
  } catch {
    return "unset";
  }
  return "unset";
}

export function hasAnalyticsConsent(): boolean {
  return getAnalyticsConsent() === "granted";
}

export function setAnalyticsConsent(consent: Exclude<AnalyticsConsentState, "unset">): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, consent);
  } catch {
    // Ignore storage write failures; analytics stays ungated by persisted consent.
  }
}

export function clearAnalyticsConsent(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(ANALYTICS_CONSENT_STORAGE_KEY);
  } catch {
    // Ignore storage write failures.
  }
}
