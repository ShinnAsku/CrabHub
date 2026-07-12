import { ChevronRight, Code2, Database, Sparkles, Table2 } from "lucide-react";
import { useAppStore, useTabStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";

export default function WelcomeScreen() {
  const { toggleAIPanel } = useAppStore();
  const { addTab } = useTabStore();

  const handleNewQuery = () => {
    addTab({ title: t('welcome.query1'), type: "query", content: "" });
    // Switch the main panel into query mode — addTab alone only mutates the
    // store; the panel listens for this event to change views.
    setTimeout(() => {
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) {
        window.dispatchEvent(new CustomEvent('openQueryTab', { detail: { tabId: newActiveId } }));
      }
    }, 0);
  };

  return (
    <div className="relative flex flex-col items-center justify-center h-full overflow-hidden">
      {/* Soft radial glow behind the hero — subtle depth without noise */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(600px 320px at 50% 38%, hsl(var(--primary) / 0.07), transparent 70%)",
        }}
      />

      <div className="relative flex flex-col items-center gap-4">
        {/* Crab Logo */}
        <div className="p-5 rounded-3xl bg-card border border-border/60 shadow-[0_8px_30px_-12px_hsl(var(--primary)/0.25)]">
          <svg width="72" height="72" viewBox="0 0 32 32" fill="none"><g transform="translate(3,3) scale(0.95)"><ellipse cx="13" cy="16" rx="8" ry="6" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><circle cx="10" cy="13" r="1.8" fill="white" /><circle cx="16" cy="13" r="1.8" fill="white" /><circle cx="10" cy="12.8" r="0.9" fill="#1a1a1a" /><circle cx="16" cy="12.8" r="0.9" fill="#1a1a1a" /><path d="M11 17.5 Q13 19, 15 17.5" stroke="#991B1B" strokeWidth="0.6" fill="none" /><path d="M5 15 C5 15, -1 10, -2 6 C-3 3, 0 3, 1 6 L3 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><path d="M-2 6 C-2 6, -4 4, -3 2 C-2 0, -1 2, 0 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" /><path d="M21 15 C21 15, 27 10, 28 6 C29 3, 26 3, 25 6 L23 10" fill="#EF4444" stroke="#DC2626" strokeWidth="0.8" /><path d="M28 6 C28 6, 30 4, 29 2 C28 0, 27 2, 26 4" fill="#DC2626" stroke="#991B1B" strokeWidth="0.5" /><path d="M7 17 L2 19 L1 21" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M7 18 L3 21 L2 23" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M8 19 L4 22 L3 24" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M19 17 L24 19 L25 21" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M19 18 L23 21 L24 23" stroke="#DC2626" strokeWidth="0.7" fill="none" /><path d="M18 19 L22 22 L23 24" stroke="#DC2626" strokeWidth="0.7" fill="none" /></g></svg>
        </div>

        <h2 className="text-xl font-semibold tracking-tight text-foreground">CrabHub</h2>
        <p className="text-[13px] text-muted-foreground text-center max-w-[300px] leading-relaxed">
          {t('welcome.description')}{" "}
          <kbd className="px-1.5 py-0.5 bg-muted border border-border/60 rounded-md text-[11px] font-mono shadow-sm">Ctrl+N</kbd>{" "}
          {t('welcome.newQuery')}
        </p>

        <div className="flex items-center gap-2.5 mt-1">
          <button
            onClick={handleNewQuery}
            className="group flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-lg
                       bg-primary text-primary-foreground shadow-[0_2px_12px_-2px_hsl(var(--primary)/0.5)]
                       hover:shadow-[0_4px_16px_-2px_hsl(var(--primary)/0.6)] hover:brightness-110
                       active:scale-[0.98] transition-all duration-150"
          >
            <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />
            {t('welcome.newQueryBtn')}
          </button>
          <button
            onClick={toggleAIPanel}
            className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-lg
                       bg-card border border-border text-foreground shadow-sm
                       hover:bg-muted hover:border-border active:scale-[0.98] transition-all duration-150"
          >
            <Code2 size={14} />
            {t('welcome.aiAssistant')}
          </button>
        </div>

        {/* Quick feature hints */}
        <div className="flex items-center gap-5 mt-6 text-[11px] text-muted-foreground/70">
          <span className="flex items-center gap-1.5"><Database size={12} />{t('welcome.hintDatabases')}</span>
          <span className="flex items-center gap-1.5"><Table2 size={12} />{t('welcome.hintEditing')}</span>
          <span className="flex items-center gap-1.5"><Sparkles size={12} />{t('welcome.hintAI')}</span>
        </div>
      </div>
    </div>
  );
}
