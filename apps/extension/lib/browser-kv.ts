import { browser } from "wxt/browser";
import type { KeyValueStore } from "./state";

/** browser.storage.local-backed KV (production implementation of the state seam). */
export const browserKv: KeyValueStore = {
  async get(key) {
    const result = await browser.storage.local.get(key);
    return result[key];
  },
  async set(key, value) {
    await browser.storage.local.set({ [key]: value });
  },
};
