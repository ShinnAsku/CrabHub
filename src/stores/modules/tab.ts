import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Tab, QueryResult } from '@/types';

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  queryResults: Record<string, QueryResult>;
  tabCounter: number;
  isExecuting: Record<string, boolean>;

  // Actions
  addTab: (tab: Omit<Tab, "id">) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  updateTabContent: (id: string, content: string) => void;
  setQueryResult: (tabId: string, result: QueryResult) => void;
  setIsExecuting: (tabId: string, v: boolean) => void;
}

// Module-level counter kept in sync with persisted state on rehydration so
// freshly generated tab ids never collide with restored ones.
let tabCounter = 0;

/**
 * Strip ephemeral / heavy fields before persisting a tab. Query results,
 * execution flags, messages and execution plans are session-only — restoring
 * them after a restart would either be wrong (executing == true with no
 * running query) or wasteful (potentially many MB of JSON rows).
 */
function persistableTab(t: Tab): Tab {
  const { queryResult: _qr, isExecuting: _ie, messages: _m, executionPlan: _ep, ...rest } = t;
  return rest;
}

export const useTabStore = create<TabState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      queryResults: {},
      tabCounter: 0,
      isExecuting: {},

      addTab: (tab) => {
        tabCounter++;
        const newTab: Tab = { ...tab, id: `tab-${tabCounter}` };
        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
          tabCounter,
        }));
        return newTab.id;
      },

      closeTab: (id) =>
        set((state) => {
          const newTabs = state.tabs.filter((t) => t.id !== id);
          let newActiveId = state.activeTabId;
          if (state.activeTabId === id) {
            const idx = state.tabs.findIndex((t) => t.id === id);
            newActiveId =
              newTabs.length > 0
                ? newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null
                : null;
          }
          // Clean up query results and executing state for closed tab
          const newQueryResults = { ...state.queryResults };
          delete newQueryResults[id];
          const newExecuting = { ...state.isExecuting };
          delete newExecuting[id];
          return { tabs: newTabs, activeTabId: newActiveId, queryResults: newQueryResults, isExecuting: newExecuting };
        }),

      setActiveTab: (id) => set({ activeTabId: id }),

      updateTabContent: (id, content) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, content, modified: true } : t
          ),
        })),

      setQueryResult: (tabId, result) =>
        set((state) => ({
          queryResults: { ...state.queryResults, [tabId]: result },
        })),

      setIsExecuting: (tabId, v) => set((state) => {
        if (state.isExecuting[tabId] === v) return {};
        return { isExecuting: { ...state.isExecuting, [tabId]: v } };
      }),
    }),
    {
      name: "crabhub-tabs",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // Only persist the tab list, active id, and counter. Ephemeral runtime
      // state (queryResults, isExecuting) is intentionally excluded.
      partialize: (state) => ({
        tabs: state.tabs.map(persistableTab),
        activeTabId: state.activeTabId,
        tabCounter: state.tabCounter,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          tabCounter = state.tabCounter ?? 0;
          // Ensure ephemeral maps exist after rehydration (persist would have
          // dropped them so they'd come back undefined).
          state.queryResults = {};
          state.isExecuting = {};
        }
      },
    }
  )
);
