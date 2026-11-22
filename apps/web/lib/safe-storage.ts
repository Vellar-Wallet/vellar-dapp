export function getSafeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    const probeKey = "__vellar_storage_probe__";
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}
