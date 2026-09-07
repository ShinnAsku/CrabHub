import { create } from "zustand";
import type { QueryHistoryEntry, SlowQueryEntry } from '@/types/index';

// Load query history from localStorage
function loadQueryHistory(): QueryHistoryEntry[] {
  try {
    const saved = localStorage.getItem("crabhub-query-history");
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return [];
}

// Save query history to localStorage
function saveQueryHistory(history: QueryHistoryEntry[]) {
  try {
    localStorage.setItem("crabhub-query-history", JSON.stringify(history));
  } catch {
    // ignore
  }
}

// Load slow query log from localStorage
function loadSlowQueryLog(): SlowQueryEntry[] {
  try {
    const saved = localStorage.getItem("crabhub-slow-queries");
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return [];
}

// Save slow query log to localStorage
function saveSlowQueryLog(log: SlowQueryEntry[]) {
  try {
    localStorage.setItem("crabhub-slow-queries", JSON.stringify(log));
  } catch {
    // ignore
  }
}

// Load slow query threshold from localStorage
function loadSlowQueryThreshold(): number {
  try {
    const saved = localStorage.getItem("crabhub-slow-query-threshold");
    if (saved) {
      const val = parseInt(saved, 10);
      if (!isNaN(val) && val >= 0) return val;
    }
  } catch {
    // ignore
  }
  return 1000; // default: 1000ms
}

interface HistoryState {
  queryHistory: QueryHistoryEntry[];
  slowQueryLog: SlowQueryEntry[];
  slowQueryThreshold: number;
  historyCounter: number;

  // Actions
  addQueryHistory: (entry: Omit<QueryHistoryEntry, "id">) => void;
  addQueryHistoryBatch: (entries: Omit<QueryHistoryEntry, "id">[]) => void;
  clearQueryHistory: () => void;
  addSlowQuery: (query: Omit<SlowQueryEntry, "id">) => void;
  clearSlowQueries: () => void;
  setSlowQueryThreshold: (ms: number) => void;
}

let historyCounter = 0;

export const useHistoryStore = create<HistoryState>((set, get) => ({
  queryHistory: loadQueryHistory(),
  slowQueryLog: loadSlowQueryLog(),
  slowQueryThreshold: loadSlowQueryThreshold(),
  historyCounter: 0,

  addQueryHistory: (entry) => get().addQueryHistoryBatch([entry]),

  addQueryHistoryBatch: (entries) => {
    if (entries.length === 0) return;
    set((state) => {
      const added = entries.map(entry => ({ ...entry, id: `hist-${++historyCounter}` }));
      const newHistory = [...added.reverse(), ...state.queryHistory].slice(0, 100);
      saveQueryHistory(newHistory);
      return { queryHistory: newHistory, historyCounter };
    });
  },

  clearQueryHistory: () =>
    set(() => {
      saveQueryHistory([]);
      return { queryHistory: [] };
    }),

  addSlowQuery: (query) =>
    set((state) => {
      const id = `slow-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const newEntry: SlowQueryEntry = { ...query, id };
      const newLog = [newEntry, ...state.slowQueryLog].slice(0, 200);
      saveSlowQueryLog(newLog);
      return { slowQueryLog: newLog };
    }),

  clearSlowQueries: () =>
    set(() => {
      saveSlowQueryLog([]);
      return { slowQueryLog: [] };
    }),

  setSlowQueryThreshold: (ms) =>
    set(() => {
      try { localStorage.setItem("crabhub-slow-query-threshold", String(ms)); } catch {}
      return { slowQueryThreshold: ms };
    }),
}));
