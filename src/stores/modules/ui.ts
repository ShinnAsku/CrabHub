import { create } from "zustand";
import { setLanguage as setI18nLanguage, initLanguage as initI18nLanguage, type Language } from "@/lib/i18n";
import type { SchemaNode, QueryResult, TableInfo, SelectedContext } from '@/types';
import { log } from "@/lib/log";

// ===== Theme system =====
// Themes are CSS variable sets selected via the `data-theme` attribute
// (see src/styles/index.css). Each theme declares whether it is dark so
// Monaco and Tailwind `dark:` utilities follow along.

export type ThemeId = "light" | "dark" | "solarized-light" | "nord" | "dracula" | "one-dark" | "midnight";

export const THEMES: { id: ThemeId; labelKey: string; dark: boolean; swatch: string }[] = [
  { id: "light", labelKey: "theme.light", dark: false, swatch: "#f5f8fc" },
  { id: "dark", labelKey: "theme.dark", dark: true, swatch: "#0b1220" },
  { id: "solarized-light", labelKey: "theme.solarizedLight", dark: false, swatch: "#fdf6e3" },
  { id: "nord", labelKey: "theme.nord", dark: true, swatch: "#2e3440" },
  { id: "dracula", labelKey: "theme.dracula", dark: true, swatch: "#282a36" },
  { id: "one-dark", labelKey: "theme.oneDark", dark: true, swatch: "#282c34" },
  { id: "midnight", labelKey: "theme.midnight", dark: true, swatch: "#000000" },
];

export function isDarkTheme(theme: ThemeId): boolean {
  return THEMES.find((t) => t.id === theme)?.dark ?? false;
}

// Load theme from localStorage
function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem("crabhub-theme");
    if (saved && THEMES.some((t) => t.id === saved)) return saved as ThemeId;
  } catch {}
  return "light";
}

// Apply theme attribute to document
function applyThemeClass(theme: ThemeId) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

// Initialize language from localStorage
const initialLanguage = initI18nLanguage();

// Load initial theme and apply
const initialTheme = loadTheme();
applyThemeClass(initialTheme);

export type NavicatTab = "tables" | "views" | "materialized_views" | "functions" | "roles" | "other" | "queries" | "backups";

interface UIState {
  aiPanelOpen: boolean;
  theme: ThemeId;
  language: Language;
  sidebarOpen: boolean;
  resultPanelOpen: boolean;
  snippetPanelOpen: boolean;
  activeNavicatTab: NavicatTab;
  selectedSchemaId: string | null;
  selectedSchemaName: string | undefined;
  selectedTableId: string | null;
  selectedTable: TableInfo | null;
  selectedTableData: QueryResult | null;
  selectedTableDDL: string;
  schemaData: Record<string, SchemaNode[]>;
  selectedContext: SelectedContext | null;
  viewModeType: "navicat" | "query";

  // Actions
  toggleAIPanel: () => void;
  toggleTheme: () => void;
  setTheme: (theme: ThemeId) => void;
  setLanguage: (lang: Language) => void;
  toggleSidebar: () => void;
  toggleResultPanel: () => void;
  setResultPanelOpen: (open: boolean) => void;
  toggleSnippetPanel: () => void;
  setActiveNavicatTab: (tab: NavicatTab) => void;
  setViewModeType: (mode: "navicat" | "query") => void;
  setSelectedSchemaId: (id: string | null) => void;
  setSelectedSchemaName: (name: string | undefined) => void;
  setSelectedTableId: (id: string | null) => void;
  setSelectedTable: (table: TableInfo | null) => void;
  setSelectedTableData: (data: QueryResult | null) => void;
  setSelectedTableDDL: (ddl: string) => void;
  setSchemaData: (connectionId: string, data: SchemaNode[]) => void;
  setSelectedContext: (ctx: SelectedContext | null) => void;
  updateSchemaChildren: (connectionId: string, parentNodeId: string, children: SchemaNode[]) => void;
}

export const useUIStore = create<UIState>((set) => ({
  aiPanelOpen: false,
  theme: initialTheme,
  language: initialLanguage,
  sidebarOpen: true,
  resultPanelOpen: true,
  snippetPanelOpen: false,
  activeNavicatTab: "tables",
  selectedSchemaId: null,
  selectedSchemaName: undefined,
  selectedTableId: null,
  selectedTable: null,
  selectedTableData: null,
  selectedTableDDL: "",
  schemaData: {},
  selectedContext: null,
  viewModeType: "navicat",

  toggleAIPanel: () =>
    set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),

  toggleTheme: () =>
    set((state) => {
      // Title-bar sun/moon button: flip between the base light/dark pair.
      // Custom themes count as their dark/light family for the flip.
      const newTheme: ThemeId = isDarkTheme(state.theme) ? "light" : "dark";
      applyThemeClass(newTheme);
      try { localStorage.setItem("crabhub-theme", newTheme); } catch {}
      return { theme: newTheme };
    }),

  setTheme: (theme) =>
    set(() => {
      applyThemeClass(theme);
      try { localStorage.setItem("crabhub-theme", theme); } catch {}
      return { theme };
    }),

  setLanguage: (lang) =>
    set(() => {
      setI18nLanguage(lang);
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      return { language: lang };
    }),

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  toggleResultPanel: () =>
    set((state) => ({ resultPanelOpen: !state.resultPanelOpen })),

  setResultPanelOpen: (open) =>
    set({ resultPanelOpen: open }),

  toggleSnippetPanel: () =>
    set((state) => ({ snippetPanelOpen: !state.snippetPanelOpen })),

  setActiveNavicatTab: (tab) => set({ activeNavicatTab: tab }),
  setViewModeType: (mode) => set({ viewModeType: mode }),
  setSelectedSchemaId: (id) => set({ selectedSchemaId: id }),
  setSelectedSchemaName: (name) => set({ selectedSchemaName: name }),
  setSelectedTableId: (id) => set({ selectedTableId: id }),
  setSelectedTable: (table) => set({ selectedTable: table }),
  setSelectedTableData: (data) => set({ selectedTableData: data }),
  setSelectedTableDDL: (ddl) => set({ selectedTableDDL: ddl }),
  setSchemaData: (connectionId, data) =>
    set((state) => ({
      schemaData: { ...state.schemaData, [connectionId]: data },
    })),
  setSelectedContext: (ctx) => {
    log.debug("[UIStore] setSelectedContext:", JSON.stringify(ctx));
    set({ selectedContext: ctx });
  },
  updateSchemaChildren: (connectionId, parentNodeId, children) =>
    set((state) => {
      const existingData = state.schemaData[connectionId] || [];
      const updateNode = (nodes: SchemaNode[]): SchemaNode[] =>
        nodes.map((node) => {
          if (node.id === parentNodeId) {
            return { ...node, children, loaded: true };
          }
          if (node.children) {
            return { ...node, children: updateNode(node.children) };
          }
          return node;
        });
      log.debug(`[UIStore] updateSchemaChildren: connectionId=${connectionId}, parentNodeId=${parentNodeId}, children=${children.length}`);
      return { schemaData: { ...state.schemaData, [connectionId]: updateNode(existingData) } };
    }),
}));
