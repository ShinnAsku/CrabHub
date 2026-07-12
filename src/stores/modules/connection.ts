import { create } from "zustand";
import type { Connection } from '@/types';
import { transportInvoke as safeInvoke } from "@/lib/tauri-commands";
import { log } from "@/lib/log";

interface ConnectionState {
  connections: Connection[];
  activeConnectionId: string | null;
  transactionActive: Record<string, boolean>;
  connCounter: number;

  // Actions
  addConnection: (conn: Omit<Connection, "id"> & { id?: string }) => Promise<void>;
  setConnections: (connections: Connection[]) => void;
  updateConnection: (id: string, updates: Partial<Connection>) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  setActiveConnection: (id: string | null) => void;
  setTransactionActive: (connectionId: string, active: boolean) => void;
  loadConnections: () => Promise<void>;
}

let connCounter = 0;

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  transactionActive: {},
  connCounter: 0,

  loadConnections: async () => {
    log.debug("[ConnectionStore] loadConnections: 开始从 SQLite 加载连接列表...");
    try {
      const stored = await safeInvoke<any[]>("get_connections");
      log.debug("[ConnectionStore] loadConnections: 从后端获取到原始数据:", JSON.stringify(stored, null, 2));
      const connections: Connection[] = stored.map((c: any) => ({
        ...c,
        type: c.db_type,
        password: c.password_encrypted || undefined,
        enableSsl: c.enable_ssl ?? false,
        keepaliveInterval: c.keepalive_interval ?? 30,
        autoReconnect: c.auto_reconnect ?? true,
        queryTimeoutSecs: c.query_timeout_secs ?? 300,
        connected: false,
        lastConnected: c.last_connected_at ? new Date(c.last_connected_at) : undefined,
      }));
      connCounter = connections.length;
      log.debug(`[ConnectionStore] loadConnections: 成功加载 ${connections.length} 个连接`);
      connections.forEach((c, i) => {
        log.debug(`  [${i}] id=${c.id}, name=${c.name}, type=${c.type}, host=${c.host}:${c.port}`);
      });
      set({ connections, connCounter });
    } catch (e) {
      console.error("[ConnectionStore] loadConnections: 加载失败:", e);
      set({ connections: [] });
    }
  },

  addConnection: async (conn) => {
    const id = conn.id || `conn-${++connCounter}`;
    log.debug(`[ConnectionStore] addConnection: 新建连接 id=${id}, name=${conn.name}, type=${conn.type}, host=${conn.host}:${conn.port}`);
    const newConn: Connection = {
      ...conn,
      id,
      type: conn.type || "postgresql",
      connected: conn.connected ?? false,
      keepaliveInterval: conn.keepaliveInterval ?? 30,
      autoReconnect: conn.autoReconnect ?? true,
    };

    try {
      const payload = {
        connection: {
          id: newConn.id,
          name: newConn.name,
          db_type: newConn.type,
          host: newConn.host,
          port: newConn.port,
          username: newConn.username,
          password_encrypted: newConn.password,
          database: newConn.database,
          enable_ssl: newConn.enableSsl ?? false,
          keepalive_interval: newConn.keepaliveInterval,
          auto_reconnect: newConn.autoReconnect,
          query_timeout_secs: newConn.queryTimeoutSecs ?? 300,
        },
      };
      log.debug("[ConnectionStore] addConnection: 发送到后端的数据:", JSON.stringify(payload, null, 2));
      await safeInvoke("add_connection", payload);
      log.debug("[ConnectionStore] addConnection: 成功保存到 SQLite");
    } catch (e) {
      console.error("[ConnectionStore] addConnection: 保存到 SQLite 失败:", e);
    }

    set((state) => ({
      connections: [...state.connections, newConn],
      connCounter,
    }));
    log.debug(`[ConnectionStore] addConnection: 本地状态已更新, 当前连接数: ${get().connections.length}`);
  },

  setConnections: (connections) => set({ connections }),

  updateConnection: async (id, updates) => {
    log.debug(`[ConnectionStore] updateConnection: id=${id}, updates=`, JSON.stringify(updates));
    const { connections } = get();
    const conn = connections.find((c) => c.id === id);
    if (!conn) {
      console.warn(`[ConnectionStore] updateConnection: 未找到连接 id=${id}, 跳过`);
      return;
    }

    const updated = { ...conn, ...updates };

    try {
      const payload = {
        connection: {
          id: updated.id,
          name: updated.name,
          db_type: updated.type,
          host: updated.host,
          port: updated.port,
          username: updated.username,
          password_encrypted: updated.password,
          database: updated.database,
          enable_ssl: updated.enableSsl ?? false,
          keepalive_interval: updated.keepaliveInterval,
          auto_reconnect: updated.autoReconnect,
          query_timeout_secs: updated.queryTimeoutSecs ?? 300,
        },
      };
      log.debug("[ConnectionStore] updateConnection: 发送到后端:", JSON.stringify(payload, null, 2));
      await safeInvoke("update_connection", payload);
      log.debug("[ConnectionStore] updateConnection: 成功更新到 SQLite");
    } catch (e) {
      console.error("[ConnectionStore] updateConnection: 更新 SQLite 失败:", e);
    }

    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    }));
    log.debug("[ConnectionStore] updateConnection: 本地状态已更新");
  },

  removeConnection: async (id) => {
    log.debug(`[ConnectionStore] removeConnection: 删除连接 id=${id}`);
    try {
      await safeInvoke("delete_connection", { id });
      log.debug("[ConnectionStore] removeConnection: 成功从 SQLite 删除");
    } catch (e) {
      console.error("[ConnectionStore] removeConnection: 从 SQLite 删除失败:", e);
    }

    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
      activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
    }));
    log.debug(`[ConnectionStore] removeConnection: 本地状态已更新, 剩余连接数: ${get().connections.length}`);
  },

  setActiveConnection: (id) => {
    log.debug(`[ConnectionStore] setActiveConnection: ${id}`);
    set({ activeConnectionId: id });
  },

  setTransactionActive: (connectionId, active) => {
    log.debug(`[ConnectionStore] setTransactionActive: connectionId=${connectionId}, active=${active}`);
    set((state) => ({
      transactionActive: { ...state.transactionActive, [connectionId]: active },
    }));
  },
}));
