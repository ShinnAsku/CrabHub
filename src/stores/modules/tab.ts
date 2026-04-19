import { create } from "zustand";
import type { Tab, QueryResult } from '@/types';

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  queryResults: Record<string, QueryResult>;
  tabCounter: number;
  isExecuting: boolean;

  // Actions
  addTab: (tab: Omit<Tab, "id">) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  updateTabContent: (id: string, content: string) => void;
  setQueryResult: (tabId: string, result: QueryResult) => void;
  setIsExecuting: (v: boolean) => void;
}

let tabCounter = 0;

export const useTabStore = create<TabState>((set) => ({
  tabs: [],
  activeTabId: null,
  queryResults: {},
  tabCounter: 0,
  isExecuting: false,

  addTab: (tab) => {
    tabCounter++;
    const newTab: Tab = { ...tab, id: `tab-${tabCounter}` };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newTab.id
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
      // Clean up query results for closed tab
      const newQueryResults = { ...state.queryResults };
      delete newQueryResults[id];
      return { tabs: newTabs, activeTabId: newActiveId, queryResults: newQueryResults };
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

  setIsExecuting: (v) => set({ isExecuting: v }),
}));
