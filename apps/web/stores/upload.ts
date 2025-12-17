"use client";

import { create } from "zustand";
import type { Id } from "@/convex/_generated/dataModel";

interface UploadStore {
  file: File | null;
  jobId: Id<"jobs"> | null;
  uploadProgress: number;
  isUploading: boolean;

  setFile: (file: File | null) => void;
  setJobId: (jobId: Id<"jobs"> | null) => void;
  setUploadProgress: (progress: number) => void;
  setIsUploading: (isUploading: boolean) => void;
  reset: () => void;
}

export const useUploadStore = create<UploadStore>((set) => ({
  file: null,
  jobId: null,
  uploadProgress: 0,
  isUploading: false,

  setFile: (file) => set({ file }),
  setJobId: (jobId) => set({ jobId }),
  setUploadProgress: (progress) => set({ uploadProgress: progress }),
  setIsUploading: (isUploading) => set({ isUploading }),
  reset: () =>
    set({ file: null, jobId: null, uploadProgress: 0, isUploading: false }),
}));
