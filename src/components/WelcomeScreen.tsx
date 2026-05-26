import { ChevronRight, Code2 } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

export default function WelcomeScreen() {
  const { addTab, toggleAIPanel } = useAppStore();

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        {/* Crab Logo */}
        <svg width="96" height="96" viewBox="0 0 32 32" fill="none" className="opacity-40"><circle cx="16" cy="16" r="15" fill="none" /><g transform="translate(3,3) scale(0.95)"><ellipse cx="13" cy="16" rx="8" ry="6" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><circle cx="10" cy="13" r="1.8" fill="white" /><circle cx="16" cy="13" r="1.8" fill="white" /><circle cx="10" cy="12.8" r="0.9" fill="#1a1a1a" /><circle cx="16" cy="12.8" r="0.9" fill="#1a1a1a" /><path d="M11 17.5 Q13 19, 15 17.5" stroke="#991B1B" strokeWidth="0.6" fill="none" /><path d="M5 15 C5 15, -1 10, -2 6 C-3 3, 0 3, 1 6 L3 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><path d="M-2 6 C-2 6, -4 4, -3 2 C-2 0, -1 2, 0 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" /><path d="M21 15 C21 15, 27 10, 28 6 C29 3, 26 3, 25 6 L23 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><path d="M28 6 C28 6, 30 4, 29 2 C28 0, 27 2, 26 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" /><path d="M7 17 L2 19 L1 21" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M7 18 L3 21 L2 23" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M8 19 L4 22 L3 24" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M19 17 L24 19 L25 21" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M19 18 L23 21 L24 23" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M18 19 L22 22 L23 24" stroke="#DC2626" strokeWidth="0.7" fill="none" /></g></svg>
        <h2 className="text-base font-medium text-foreground/60">CrabHub</h2>
        <p className="text-xs text-muted-foreground/60 text-center max-w-[240px]">
          {t('welcome.description')}{" "}
          <kbd className="px-1 py-0.5 bg-muted rounded text-[11px]">Ctrl+N</kbd>{" "}
          {t('welcome.newQuery')}
        </p>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => addTab({ title: t('welcome.query1'), type: "query", content: "" })}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-muted rounded transition-colors text-foreground"
          >
            <ChevronRight size={13} />
            {t('welcome.newQueryBtn')}
          </button>
          <button
            onClick={toggleAIPanel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-muted rounded transition-colors text-foreground"
          >
            <Code2 size={13} />
            {t('welcome.aiAssistant')}
          </button>
        </div>
      </div>
    </div>
  );
}
