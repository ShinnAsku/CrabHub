import { Minus, Square, X } from "lucide-react";

export function TitleBar() {
  // Handle non-Tauri environments gracefully
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const minimize = () => {
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().minimize();
      });
    }
  };

  const toggleMaximize = () => {
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().toggleMaximize();
      });
    }
  };

  const close = () => {
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().close();
      });
    }
  };

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between h-10 px-3
        bg-background/80 backdrop-blur-xl border-b border-border/50
        select-none shrink-0"
    >
      <div className="flex items-center gap-2 pl-[70px]">
        <span className="text-xs font-medium text-muted-foreground">CrabHub</span>
      </div>
      {isTauri && (
        <div className="flex items-center gap-0.5">
          <button
            onClick={minimize}
            className="p-2 hover:bg-secondary rounded-md transition-colors"
            aria-label="Minimize"
          >
            <Minus size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={toggleMaximize}
            className="p-2 hover:bg-secondary rounded-md transition-colors"
            aria-label="Maximize"
          >
            <Square size={12} strokeWidth={1.5} />
          </button>
          <button
            onClick={close}
            className="p-2 hover:bg-destructive hover:text-destructive-foreground rounded-md transition-colors"
            aria-label="Close"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );
}
