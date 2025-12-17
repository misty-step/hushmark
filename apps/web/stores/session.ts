"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

interface SessionStore {
  sessionId: string;
  ensureSession: () => string;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      sessionId: "",
      ensureSession: () => {
        let { sessionId } = get();
        if (!sessionId) {
          sessionId = nanoid();
          set({ sessionId });
        }
        return sessionId;
      },
    }),
    { name: "hushmark-session" }
  )
);
