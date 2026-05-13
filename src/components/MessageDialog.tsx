import { useState, useEffect, useCallback } from "react";

interface MessageDialogState {
  message: string;
  resolve: (() => void) | null;
}

let pendingResolve: (() => void) | null = null;

export function showMessage(message: string): Promise<void> {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    window.dispatchEvent(new CustomEvent("crabhub:showMessage", { detail: message }));
  });
}

export default function MessageDialog() {
  const [state, setState] = useState<MessageDialogState>({ message: "", resolve: null });

  const handleShow = useCallback((e: Event) => {
    setState({ message: (e as CustomEvent).detail, resolve: pendingResolve });
  }, []);

  const handleClose = useCallback(() => {
    if (state.resolve) state.resolve();
    setState({ message: "", resolve: null });
    pendingResolve = null;
  }, [state]);

  useEffect(() => {
    window.addEventListener("crabhub:showMessage", handleShow);
    return () => window.removeEventListener("crabhub:showMessage", handleShow);
  }, [handleShow]);

  if (!state.message) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onClick={handleClose}>
      <div
        className="bg-background border border-border rounded-lg shadow-xl max-w-sm w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-foreground leading-relaxed">{state.message}</p>
        <div className="flex justify-end mt-4">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
