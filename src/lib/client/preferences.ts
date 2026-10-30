"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { DownloadRequest } from "@/lib/contracts";

type Preferences = Pick<DownloadRequest, "audioFormat" | "audioQuality"> & { keepInLibrary: boolean };
type PreferenceStore = Preferences & {
  setAudioFormat: (audioFormat: Preferences["audioFormat"]) => void;
  setAudioQuality: (audioQuality: Preferences["audioQuality"]) => void;
  setKeepInLibrary: (keepInLibrary: boolean) => void;
};

const preferenceStorage = createJSONStorage<Preferences>(() => ({
  getItem: (key) => {
    try { return typeof window === "undefined" ? null : window.localStorage.getItem(key); } catch { return null; }
  },
  setItem: (key, value) => {
    try { if (typeof window !== "undefined") window.localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
  },
  removeItem: (key) => {
    try { if (typeof window !== "undefined") window.localStorage.removeItem(key); } catch { /* Preferences are optional. */ }
  },
} satisfies StateStorage));

export const usePreferenceStore = create<PreferenceStore>()(persist(
  (set) => ({
    audioFormat: "m4a",
    audioQuality: "best",
    keepInLibrary: false,
    setAudioFormat: (audioFormat) => set({ audioFormat }),
    setAudioQuality: (audioQuality) => set({ audioQuality }),
    setKeepInLibrary: (keepInLibrary) => set({ keepInLibrary }),
  }),
  { name: "vipod.preferences", storage: preferenceStorage, skipHydration: true, partialize: ({ audioFormat, audioQuality, keepInLibrary }) => ({ audioFormat, audioQuality, keepInLibrary }) },
));
