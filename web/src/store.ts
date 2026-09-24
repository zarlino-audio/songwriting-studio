import { create } from "zustand";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

interface StudioState {
  toasts: Toast[];
  pushToast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: number) => void;
  aiPanelOpen: boolean;
  setAiPanelOpen: (open: boolean) => void;
}

let toastId = 1;

export const useStudio = create<StudioState>((set) => ({
  toasts: [],
  pushToast: (kind, message) => {
    const id = toastId++;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    if (kind !== "error") {
      setTimeout(() => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })), 3800);
    }
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  aiPanelOpen: true,
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
}));
