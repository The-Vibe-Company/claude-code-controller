import { useEffect, useRef, useCallback } from "react";
import { useStore, type ToastItem } from "../store.js";

const TOAST_DURATION_MS = 5_000;
const DISMISS_ANIMATION_MS = 300;

function levelAccent(level: ToastItem["level"]): string {
  switch (level) {
    case "success": return "bg-cc-success";
    case "error": return "bg-cc-error";
    case "warning": return "bg-cc-warning";
    default: return "bg-cc-primary";
  }
}

function LevelIcon({ level }: { level: ToastItem["level"] }) {
  const cls = "w-4 h-4 shrink-0";
  switch (level) {
    case "success":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={`${cls} text-cc-success`}>
          <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
        </svg>
      );
    case "error":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={`${cls} text-cc-error`}>
          <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zM5.354 5.354a.5.5 0 01.707 0L8 7.293l1.94-1.94a.5.5 0 01.707.708L8.707 8l1.94 1.94a.5.5 0 01-.707.707L8 8.707l-1.94 1.94a.5.5 0 01-.707-.707L7.293 8 5.354 6.06a.5.5 0 010-.707z" clipRule="evenodd" />
        </svg>
      );
    case "warning":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={`${cls} text-cc-warning`}>
          <path fillRule="evenodd" d="M8.893 1.5c-.183-.31-.52-.5-.887-.5s-.703.19-.886.5L.138 13a1.02 1.02 0 00.886 1.5h13.953c.367 0 .704-.19.886-.5s.184-.61 0-.92L8.893 1.5zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={`${cls} text-cc-primary`}>
          <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm.75-10.25a.75.75 0 00-1.5 0v1a.75.75 0 001.5 0v-1zM8 7a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 7z" clipRule="evenodd" />
        </svg>
      );
  }
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  return (
    <div
      className="group flex overflow-hidden rounded-xl bg-cc-card border border-cc-border shadow-lg pointer-events-auto"
      style={{ animation: toast.dismissed ? `toastSlideOut ${DISMISS_ANIMATION_MS}ms ease-in forwards` : `toastSlideIn 200ms ease-out` }}
    >
      {/* Accent bar */}
      <div className={`w-1 shrink-0 ${levelAccent(toast.level)}`} />

      <div className="flex items-start gap-2.5 px-3 py-2.5 min-w-0 flex-1">
        <LevelIcon level={toast.level} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold text-cc-fg truncate">{toast.title}</span>
            {toast.count > 1 && (
              <span className="text-[10px] font-semibold text-cc-muted bg-cc-hover rounded-full px-1.5 leading-[16px]">
                &times;{toast.count}
              </span>
            )}
          </div>
          <p className="text-[11px] text-cc-muted mt-0.5 line-clamp-2">{toast.message}</p>
        </div>

        {/* Dismiss button — visible on hover */}
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-cc-muted opacity-0 group-hover:opacity-100 hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
          aria-label="Dismiss notification"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleDismiss = useCallback((id: string) => {
    dismissToast(id);
    // Clean up after animation
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
  }, [dismissToast]);

  // Auto-dismiss logic
  useEffect(() => {
    const timers = timersRef.current;
    for (const toast of toasts) {
      if (toast.dismissed || timers.has(toast.id)) continue;
      const timer = setTimeout(() => {
        handleDismiss(toast.id);
      }, TOAST_DURATION_MS);
      timers.set(toast.id, timer);
    }
    return () => {
      // No cleanup on unmount — timers are per-toast
    };
  }, [toasts, handleDismiss]);

  // Clean up dismissed toasts after animation completes
  useEffect(() => {
    const dismissed = toasts.filter((t) => t.dismissed);
    if (dismissed.length === 0) return;
    const timer = setTimeout(() => {
      useStore.setState((s) => ({
        toasts: s.toasts.filter((t) => !t.dismissed),
      }));
    }, DISMISS_ANIMATION_MS + 50);
    return () => clearTimeout(timer);
  }, [toasts]);

  const visible = toasts.filter((t) => !t.dismissed || true); // Show all, dismissed ones animate out
  if (visible.length === 0) return null;

  return (
    <div className="fixed z-50 flex flex-col gap-2 pointer-events-none top-14 right-4 max-w-sm sm:max-w-[340px]">
      {visible.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={() => handleDismiss(toast.id)} />
      ))}
    </div>
  );
}
