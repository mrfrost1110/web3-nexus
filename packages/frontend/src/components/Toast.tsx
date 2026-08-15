"use client";

/**
 * Toast notification system.
 *
 * Exists to narrate the blockchain transaction lifecycle, which is slow and multi-stage in
 * a way ordinary web requests are not: a write is signed in the wallet, broadcast, then
 * mined some blocks later. The dashboard and admin pages fire a toast at each of those
 * transitions so the delay reads as progress rather than a frozen UI.
 *
 * Mounted once by the root layout; consumed via the `useToast` hook.
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { CheckCircle, AlertCircle, Info, X } from "lucide-react";

/** Severity of a toast, selecting its icon and accent color. */
export type ToastType = "success" | "error" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  showToast: (message: string, type: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

/** How long a toast stays on screen before dismissing itself, in milliseconds. */
const TOAST_DURATION_MS = 4000;

/**
 * Accesses the toast API from any client component below `ToastProvider`.
 *
 * @throws If called outside the provider. Failing loudly here turns a silently missing
 *         provider — which would otherwise swallow every notification — into an immediate
 *         error at the call site.
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  /**
   * Queues a toast and schedules its removal.
   *
   * Every state update goes through the functional form of `setToasts`. Transactions can
   * resolve in quick succession, and reading `toasts` directly would let two updates in
   * the same tick overwrite each other from the same stale snapshot.
   *
   * `useCallback` with an empty dependency list keeps this reference stable, which matters
   * because consumers list `showToast` in their effect dependencies — an unstable
   * reference would re-run those effects on every render.
   */
  const showToast = useCallback((message: string, type: ToastType) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);

    // Removal is keyed by id rather than index, so a toast dismissed by hand meanwhile
    // does not shift another toast into the expiring slot.
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  /** Removes a toast immediately, on click or via the close button. */
  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      {/* Stack renders after `children` so it paints above the page without needing a portal. */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            onClick={() => removeToast(toast.id)}
            style={{ cursor: "pointer" }}
          >
            {toast.type === "success" && <CheckCircle size={20} style={{ color: "var(--success)" }} />}
            {toast.type === "error" && <AlertCircle size={20} style={{ color: "var(--error)" }} />}
            {toast.type === "info" && <Info size={20} style={{ color: "var(--neon-cyan)" }} />}

            <div style={{ flex: 1, fontSize: "14px", lineHeight: "1.4" }}>
              {toast.message}
            </div>

            <button
              onClick={(e) => {
                // The whole toast is clickable to dismiss; without this the click would
                // also reach that handler and fire `removeToast` twice.
                e.stopPropagation();
                removeToast(toast.id);
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
              }}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
