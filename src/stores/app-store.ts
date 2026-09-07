// Re-export sub-stores as the primary import surface.
// Components should import directly from sub-stores for minimal re-renders.
export { useConnectionStore } from "@/features/connections/store";
export { useTabStore } from "@/stores/modules/tab";
export { useUIStore } from "@/stores/modules/ui";
export { useHistoryStore } from "@/stores/modules/history";

// Re-export types for convenience
export * from "@/features/connections/store";
export * from "@/stores/modules/tab";
export * from "@/stores/modules/ui";
export * from "@/stores/modules/history";
