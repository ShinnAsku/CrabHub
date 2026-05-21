import { Minus, Square, X, Sun, Moon, Globe } from "lucide-react";
import { useAppStore } from "@/stores/app-store";

export function TitleBar() {
  const { theme, toggleTheme, language, setLanguage } = useAppStore();

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
        bg-background/80 backdrop-blur-xl shadow-[0_1px_3px_rgba(0,0,0,0.04)]
        select-none shrink-0"
    >
      <div className="flex items-center gap-2 pl-[70px]">
        <span className="text-xs font-medium text-muted-foreground">CrabHub</span>
      </div>
      <div className="flex items-center gap-0.5">
        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          className="p-1.5 hover:bg-secondary rounded-md transition-colors"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
        </button>

        {/* Language Switch */}
        <button
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          className="p-1.5 hover:bg-secondary rounded-md transition-colors text-xs font-medium"
          title={language === 'zh' ? 'Switch to English' : 'Switch to Chinese'}
        >
          <Globe size={14} strokeWidth={1.5} />
        </button>

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
    </div>
  );
}
