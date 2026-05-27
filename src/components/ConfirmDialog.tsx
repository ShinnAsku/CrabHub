import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", handleKeyDown);
    // Auto-focus confirm button
    setTimeout(() => confirmBtnRef.current?.focus(), 50);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative bg-background border border-border rounded-lg shadow-xl p-5 w-[360px] max-w-[90vw]">
        {title && (
          <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
        )}
        <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            {cancelLabel || t("common.cancel")}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            className={`px-3 py-1.5 text-xs text-white rounded transition-colors ${
              variant === "destructive"
                ? "bg-destructive hover:bg-destructive/90"
                : "bg-[hsl(var(--tab-active))] hover:opacity-90"
            }`}
          >
            {confirmLabel || t("common.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
