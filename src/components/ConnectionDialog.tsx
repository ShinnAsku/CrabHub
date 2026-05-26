import { useState, useEffect, useCallback } from "react";
import {
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  Plug,
  X,
  Check,
  Loader2,
  Globe,
  Lock,
  Server,
  Settings,
  ChevronDown,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useConnectionStore } from "@/stores/modules/connection";
import type { Connection, ConnectionConfig } from "@/types";
import { connectDatabase, disconnectDatabase, testConnection } from "@/lib/tauri-commands";
import { storePassword, getPassword, removePassword } from "@/lib/secure-storage";
import { t } from "@/lib/i18n";
import { showMessage } from "./MessageDialog";
import { log } from "@/lib/log";

interface ConnectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  editConnection?: Connection;
}

// 内置数据库类型
const BUILTIN_DB_TYPES: { value: string; label: string; port: number; color: string }[] = [
  { value: "postgresql", label: "PostgreSQL", port: 5432, color: "#336791" },
  { value: "mysql", label: "MySQL", port: 3306, color: "#4479A1" },
  { value: "gaussdb", label: "GaussDB", port: 8000, color: "#FF6B00" },
  { value: "clickhouse", label: "ClickHouse", port: 8123, color: "#FFCC00" },
  { value: "sqlite", label: "SQLite", port: 0, color: "#44A05E" },
  { value: "kingbase", label: "Kingbase", port: 54321, color: "#D4212A" },
  { value: "vastbase", label: "Vastbase", port: 5432, color: "#0067B8" },
  { value: "yashandb", label: "YashanDB", port: 1688, color: "#00A870" },
  { value: "oceanbase", label: "OceanBase", port: 3306, color: "#0077C8" },
  { value: "tidb", label: "TiDB", port: 3306, color: "#E6005C" },
  { value: "tdsql", label: "TDSQL", port: 3306, color: "#0052D9" },
  { value: "oracle", label: "Oracle", port: 1521, color: "#F80000" },
  { value: "sqlserver", label: "SQL Server", port: 1433, color: "#CC2927" },
  { value: "dameng", label: "DaMeng", port: 5236, color: "#BA0C2F" },
  { value: "gbase", label: "GBase", port: 5258, color: "#1E6C93" },
];

// 插件数据库类型接口
interface PluginDbType {
  value: string;
  label: string;
  port: number;
  color: string;
}

// 已安装插件接口



const TABS = [
  { id: "general", label: t('connection.tabGeneral'), icon: Globe },
  { id: "advanced", label: t('connection.tabAdvanced'), icon: Settings },
  { id: "database", label: t('connection.tabDatabase'), icon: Database },
  { id: "ssl", label: "SSL", icon: Lock },
  { id: "ssh", label: "SSH", icon: Server },
];

function ConnectionDialog({ isOpen, onClose, editConnection }: ConnectionDialogProps) {
  const { addConnection, updateConnection, setActiveConnection } = useConnectionStore();

  const [activeTab, setActiveTab] = useState("general");
  const [name, setName] = useState("");
  const [type, setType] = useState<Connection["type"]>("postgresql");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [database, setDatabase] = useState("");
  const [sslEnabled, setSslEnabled] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [sqliteMode, setSqliteMode] = useState<"existing" | "new">("existing");

  // Advanced settings
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sslCaCert, setSslCaCert] = useState("");
  const [sslClientCert, setSslClientCert] = useState("");
  const [sslClientKey, setSslClientKey] = useState("");
  const [keepaliveInterval, setKeepaliveInterval] = useState(30);
  const [autoReconnect, setAutoReconnect] = useState(true);

  // Connection pool overrides (empty string = use backend default)
  const [poolMaxConnections, setPoolMaxConnections] = useState<string>("");
  const [poolIdleTimeoutSecs, setPoolIdleTimeoutSecs] = useState<string>("");
  const [poolMaxLifetimeSecs, setPoolMaxLifetimeSecs] = useState<string>("");
  const [poolAcquireTimeoutSecs, setPoolAcquireTimeoutSecs] = useState<string>("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // 插件数据库类型
  const [pluginDbTypes, setPluginDbTypes] = useState<PluginDbType[]>([]);


  const isSQLite = type === "sqlite";

  /** Convert the four pool-option text inputs into the typed object. */
  const buildPoolOptions = (): ConnectionConfig["poolOptions"] => {
    const parsePos = (s: string) => {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const parseNonNeg = (s: string) => {
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const out: NonNullable<ConnectionConfig["poolOptions"]> = {
      maxConnections: parsePos(poolMaxConnections),
      idleTimeoutSecs: parseNonNeg(poolIdleTimeoutSecs),
      maxLifetimeSecs: parseNonNeg(poolMaxLifetimeSecs),
      acquireTimeoutSecs: parsePos(poolAcquireTimeoutSecs),
    };
    const hasAny = Object.values(out).some((v) => v !== undefined);
    return hasAny ? out : undefined;
  };

  // 加载插件数据库类型
  useEffect(() => {
    const loadPluginDbTypes = async () => {
      try {
        const installedPlugins = await invoke<any[]>("list_plugins");
        
        // 加载插件状态（启用/禁用）
        const status: Record<string, boolean> = {};
        installedPlugins.forEach(plugin => {
          status[plugin.id] = plugin.enabled ?? true; // Use enabled status from plugin data or default to enabled
        });
        
        // 只加载启用的插件
        const pluginTypes: PluginDbType[] = installedPlugins
          .filter(plugin => plugin.enabled ?? true)
          .map(plugin => ({
            value: `plugin:${plugin.id}`,
            label: plugin.name,
            port: plugin.default_port || 0,
            color: "#6c757d" // 灰色，代表插件
          }));
        setPluginDbTypes(pluginTypes);
      } catch (error) {
        console.error("Failed to load plugin database types:", error);
      }
    };

    if (isOpen) loadPluginDbTypes();
  }, [isOpen]);

  // 获取所有数据库类型（内置 + 插件）
  const getAllDbTypes = (): Array<{ value: string; label: string; port: number; color: string }> => {
    return [...BUILTIN_DB_TYPES, ...pluginDbTypes];
  };

  // Populate form when editing
  useEffect(() => {
    const loadPassword = async () => {
      if (isOpen && editConnection) {
        const savedPassword = await getPassword(editConnection.id);
        if (savedPassword) {
          setPassword(savedPassword);
        }
      }
    };

    if (isOpen) {
      if (editConnection) {
        setName(editConnection.name);
        setType(editConnection.type);
        setHost(editConnection.host || "localhost");
        setPort(editConnection.port || 5432);
        setUsername(editConnection.username || "root");
        setPassword(editConnection.password || "");
        setDatabase(editConnection.database || "");
        setSslEnabled(editConnection.enableSsl || false);
        setKeepaliveInterval(editConnection.keepaliveInterval ?? 30);
        setAutoReconnect(editConnection.autoReconnect ?? true);
        const po = editConnection.poolOptions;
        setPoolMaxConnections(po?.maxConnections != null ? String(po.maxConnections) : "");
        setPoolIdleTimeoutSecs(po?.idleTimeoutSecs != null ? String(po.idleTimeoutSecs) : "");
        setPoolMaxLifetimeSecs(po?.maxLifetimeSecs != null ? String(po.maxLifetimeSecs) : "");
        setPoolAcquireTimeoutSecs(po?.acquireTimeoutSecs != null ? String(po.acquireTimeoutSecs) : "");
        setFilePath(editConnection.filePath || editConnection.database || "");
        loadPassword();
        
        // Load SSH tunnel configuration
        if (editConnection.sshTunnel) {
          setSshEnabled(true);
          setSshHost(editConnection.sshTunnel.host || "");
          setSshPort(editConnection.sshTunnel.port || 22);
          setSshUsername(editConnection.sshTunnel.username || "");
          setSshPassword(editConnection.sshTunnel.password || "");
          setSshPrivateKey(editConnection.sshTunnel.privateKey || "");
        } else {
          setSshEnabled(false);
          setSshHost("");
          setSshPort(22);
          setSshUsername("");
          setSshPassword("");
          setSshPrivateKey("");
        }
      } else {
        resetForm();
      }
    }
  }, [editConnection, isOpen]);

  // Auto-fill port when type changes
  useEffect(() => {
    if (!editConnection) {
      const dbType = getAllDbTypes().find((d) => d.value === type);
      if (dbType) {
        setPort(dbType.port);
        // Set default username based on database type
        if (type === "clickhouse") {
          setUsername("default");
        } else if (type === "postgresql") {
          setUsername("postgres");
          setDatabase("postgres");
        } else if (type === "gaussdb") {
          setUsername("gaussdb");
          setDatabase("gaussdb");
        } else if (type.startsWith("plugin:")) {
          // 插件类型的默认值
          setUsername("");
          setDatabase("");
        } else {
          setUsername("root");
          setDatabase("");
        }
      }
    }
  }, [type, editConnection, pluginDbTypes]);

  // Set default values for new connections
  useEffect(() => {
    if (isOpen && !editConnection) {
      setActiveTab("general");
      setName("");
      setType("postgresql");
      setHost("localhost");
      setPort(5432);
      setUsername("postgres");
      setPassword("");
      setDatabase("postgres");
      setSslEnabled(false);
      setFilePath("");
      setSqliteMode("existing");
      setTestResult(null);
      setSshEnabled(false);
      setSshHost("");
      setSshPort(22);
      setSshUsername("");
      setSshPassword("");
      setSshPrivateKey("");
      setSslCaCert("");
      setSslClientCert("");
      setSslClientKey("");
      setKeepaliveInterval(30);
      setAutoReconnect(true);
      setPoolMaxConnections("");
      setPoolIdleTimeoutSecs("");
      setPoolMaxLifetimeSecs("");
      setPoolAcquireTimeoutSecs("");
    }
  }, [isOpen, editConnection]);

  const resetForm = () => {
    setActiveTab("general");
    setName("");
    setType("postgresql");
    setHost("localhost");
    setPort(5432);
    setUsername("postgres");
    setPassword("");
    setShowPassword(false);
    setDatabase("postgres");
    setSslEnabled(false);
    setFilePath("");
    setSqliteMode("existing");
    setTestResult(null);
    setSshEnabled(false);
    setSshHost("");
    setSshPort(22);
    setSshUsername("");
    setSshPassword("");
    setSshPrivateKey("");
    setSslCaCert("");
    setSslClientCert("");
    setSslClientKey("");
    setKeepaliveInterval(30);
    setAutoReconnect(true);
    setPoolMaxConnections("");
    setPoolIdleTimeoutSecs("");
    setPoolMaxLifetimeSecs("");
    setPoolAcquireTimeoutSecs("");
  };

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const config: ConnectionConfig = {
        id: crypto.randomUUID(),
        name: name || "Test Connection",
        type,
        host: isSQLite ? "" : host,
        port: isSQLite ? 0 : port,
        username: isSQLite ? "" : username,
        password: isSQLite ? "" : password,
        database: isSQLite ? filePath : (database.trim() || undefined),
        enableSsl: sslEnabled,
        keepaliveInterval,
        autoReconnect,
        filePath: isSQLite ? filePath : undefined,
        poolOptions: buildPoolOptions(),
      };
      log.debug("Testing connection with", { name: config.name, type: config.type, host: config.host, port: config.port, database: config.database });
      const success = await testConnection(config);
      log.debug("Connection test result:", success);
      
      // 弹窗提示测试结果
      if (success) {
        await showMessage(t('connection.testSuccessMsg'));
      } else {
        await showMessage(t('connection.testFailedMsg'));
      }
      
      setTestResult({
        success,
        message: success ? t('connection.testSuccess') : t('connection.testFailed'),
      });
      
      // Auto clear test result after 3 seconds
      setTimeout(() => {
        setTestResult(null);
      }, 3000);
    } catch (err) {
      console.error("Connection test error:", err);
      const errorMessage = err instanceof Error ? err.message : JSON.stringify(err);
      
      await showMessage(`${t('connection.testError')}: ${errorMessage}`);
      
      setTestResult({
        success: false,
        message: errorMessage || t('connection.testError'),
      });
      
      // Auto clear error message after 5 seconds
      setTimeout(() => {
        setTestResult(null);
      }, 5000);
    } finally {
      setTesting(false);
    }
  }, [name, type, host, port, username, password, database, sslEnabled, filePath, isSQLite, keepaliveInterval, autoReconnect]);



  const handleBrowse = async () => {
    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      let selected: string | null = null;

      if (sqliteMode === "new") {
        selected = await dialog.save({
          filters: [{ name: "SQLite Database", extensions: ["db", "sqlite", "sqlite3"] }],
          defaultPath: "new_database.db",
        });
      } else {
        const result = await dialog.open({
          multiple: false,
          filters: [{ name: "SQLite Database", extensions: ["db", "sqlite", "sqlite3"] }],
        });
        selected = result as string | null;
      }

      if (selected) {
        setFilePath(selected);
        if (!name) {
          const filename = selected.split(/[/\\]/).pop() || "";
          setName(filename.replace(/\.(db|sqlite|sqlite3)$/, ""));
        }
      }
    } catch {
      // Fallback: just use input
    }
  };

  const handleSave = async () => {
    log.debug('Save button clicked!');
    
    // Validate connection name - must be filled
    if (!name.trim()) {
      await showMessage(t('connection.nameRequired'));
      return;
    }

    // PostgreSQL-like databases require a database name
    if ((type === "postgresql" || type === "gaussdb") && !database.trim()) {
      await showMessage(t('connection.databaseRequired'));
      return;
    }

    // Network databases require host + valid port
    if (!isSQLite) {
      if (!host.trim()) {
        await showMessage(t('connection.hostRequired'));
        return;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        await showMessage(t('connection.portInvalid'));
        return;
      }
    }

    // SSH tunnel validation
    if (sshEnabled) {
      if (!sshHost.trim()) {
        await showMessage(t('connection.sshHostRequired'));
        return;
      }
      if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
        await showMessage(t('connection.sshPortInvalid'));
        return;
      }
      if (!sshPassword && !sshPrivateKey) {
        await showMessage(t('connection.sshAuthRequired'));
        return;
      }
      if (sshPrivateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sshPrivateKey)) {
        await showMessage(t('connection.sshKeyInvalid'));
        return;
      }
    }

    // Check for duplicate connection name
    const existingConnections = useConnectionStore.getState().connections;
    const duplicateName = existingConnections.find(
      (c) => c.name.toLowerCase() === name.trim().toLowerCase() && c.id !== editConnection?.id
    );
    if (duplicateName) {
      await showMessage(t('connection.nameExists'));
      return;
    }
    
    setSaving(true);
    try {
      const newId = editConnection?.id || crypto.randomUUID();
      // Generate default name if not provided: {host} ({dbType})
      const defaultName = editConnection ? name : `${host} (${type})`;
      const connectionName = name.trim() || defaultName;
      const config: ConnectionConfig = {
            id: newId,
            name: connectionName,
            type,
            host: isSQLite ? "" : host,
            port: isSQLite ? 0 : port,
            username: isSQLite ? "" : username,
            password: isSQLite ? "" : password,
            database: isSQLite ? filePath : (database.trim() || undefined),
            enableSsl: sslEnabled,
            keepaliveInterval,
            autoReconnect,
            filePath: isSQLite ? filePath : undefined,
            poolOptions: buildPoolOptions(),
            sshTunnel: sshEnabled ? {
              host: sshHost,
              port: sshPort,
              username: sshUsername,
              password: sshPassword || undefined,
              privateKey: sshPrivateKey || undefined,
            } : undefined,
        };
      log.debug('Connection config:', { name: config.name, type: config.type, host: config.host, port: config.port, database: config.database });

      // Store password securely if not SQLite
      if (!isSQLite && password) {
        log.debug('Storing password for:', newId);
        await storePassword(newId, password);
      } else if (!isSQLite && !password && editConnection) {
        // Remove password if it's being cleared
        log.debug('Removing password for:', newId);
        await removePassword(newId);
      }

      if (editConnection) {
        log.debug('Updating existing connection:', editConnection.id);
        // If currently connected, disconnect and reconnect with new config
        if (editConnection.connected) {
          try {
            await disconnectDatabase(editConnection.id);
          } catch {
            // Ignore disconnect errors
          }
          try {
            await connectDatabase(config);
          } catch {
            // Reconnect failed, update store anyway
          }
        }
        updateConnection(editConnection.id, {
          name: connectionName,
          type,
          host: isSQLite ? "" : host,
          port: isSQLite ? 0 : port,
          username: isSQLite ? "" : username,
          password: isSQLite ? "" : password,
          database: isSQLite ? filePath : (database.trim() || undefined),
          enableSsl: sslEnabled,
          keepaliveInterval,
          autoReconnect,
          poolOptions: buildPoolOptions(),
          sshTunnel: sshEnabled ? {
            host: sshHost,
            port: sshPort,
            username: sshUsername,
            password: sshPassword || undefined,
            privateKey: sshPrivateKey || undefined,
          } : undefined,
        });
        log.debug('Connection updated successfully');
      } else {
        log.debug('Adding new connection');
        // Try to connect
        let connected = false;
        let detectedType: string = type;
        try {
          const result = await connectDatabase(config);
          connected = true;
          if (result.detectedType) {
            detectedType = result.detectedType;
          }
          log.debug('Connection successful, detected type:', detectedType);
        } catch (error) {
          console.error('Connection failed:', error);
          // Save without connecting
        }
        log.debug('Adding connection to store...');
        addConnection({
          id: newId,
          name: connectionName,
          type: detectedType as Connection['type'],
          host: isSQLite ? "" : host,
          port: isSQLite ? 0 : port,
          username: isSQLite ? "" : username,
          password: isSQLite ? "" : password,
          database: isSQLite ? filePath : (database.trim() || undefined),
          enableSsl: sslEnabled,
          keepaliveInterval,
          autoReconnect,
          poolOptions: buildPoolOptions(),
          connected,
        });
        log.debug('Connection added to store');
        if (connected) {
          setActiveConnection(newId);
          log.debug('Active connection set to:', newId);
        }
      }

      log.debug('Closing dialog and resetting form');
      onClose();
      resetForm();
    } catch (error) {
      console.error('Save error:', error);
    } finally {
      setSaving(false);
      log.debug('Save operation completed');
    }
  };

  if (!isOpen) return null;

  const renderTabContent = () => {
    switch (activeTab) {
      case "general":
        return (
          <div className="space-y-3">
            {/* Name */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('connection.name')}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('connection.namePlaceholder')}
                className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
              />
            </div>

            {/* Type */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('connection.type')}</label>
              <div className="relative">
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as Connection["type"])}
                  className="w-full appearance-none pl-7 pr-8 py-2 text-xs bg-background border border-border rounded-md outline-none focus:border-[hsl(var(--tab-active))] focus:ring-1 focus:ring-[hsl(var(--tab-active))/30 transition-all text-foreground cursor-pointer hover:border-muted-foreground/30"
                >
                  {BUILTIN_DB_TYPES.map((db) => (
                    <option key={db.value} value={db.value}>
                      {db.label}
                    </option>
                  ))}
                  {pluginDbTypes.length > 0 && (
                    <optgroup label={pluginDbTypes.length > 0 ? "────────── Plugin ──────────" : undefined as any}>
                      {pluginDbTypes.map((db) => (
                        <option key={db.value} value={db.value}>
                          {db.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <Database
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: getAllDbTypes().find((d) => d.value === type)?.color }}
                />
                <ChevronDown
                  size={12}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
              </div>
            </div>

            {/* SQLite file path */}
            {isSQLite ? (
              <div className="space-y-2.5">
                {/* Type radio buttons - Navicat style */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('connection.sqliteType')}</label>
                  <div className="flex flex-col gap-1.5">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground">
                      <input
                        type="radio"
                        name="sqliteMode"
                        checked={sqliteMode === "existing"}
                        onChange={() => { setSqliteMode("existing"); setFilePath(""); }}
                        className="accent-[hsl(var(--tab-active))]"
                      />
                      {t('connection.sqliteExisting')}
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground">
                      <input
                        type="radio"
                        name="sqliteMode"
                        checked={sqliteMode === "new"}
                        onChange={() => { setSqliteMode("new"); setFilePath(""); }}
                        className="accent-[hsl(var(--tab-active))]"
                      />
                      {t('connection.sqliteNew')}
                    </label>
                  </div>
                </div>

                {/* Database file path */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('connection.filePath')}</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={filePath}
                      onChange={(e) => setFilePath(e.target.value)}
                      placeholder={sqliteMode === "new" ? t('connection.sqliteNewPlaceholder') : "/path/to/database.db"}
                      className="flex-1 px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
                    />
                    <button aria-label={t('connection.browse')} onClick={handleBrowse}
                      className="p-1.5 bg-muted border border-border rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title={t('connection.browse')}
                    >
                      <FolderOpen size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Host + Port row */}
                <div className="flex gap-2">
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-muted-foreground">{t('connection.host')}</label>
                    <input
                      type="text"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="localhost"
                      className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
                    />
                  </div>
                  <div className="w-24 space-y-1">
                    <label className="text-xs text-muted-foreground">{t('connection.port')}</label>
                    <input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground"
                    />
                  </div>
                </div>

                {/* Username + Password row */}
                <div className="flex gap-2">
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-muted-foreground">{t('connection.username')}</label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder={type === "clickhouse" ? "default" : type === "postgresql" ? "postgres" : type === "gaussdb" ? "gaussdb" : "root"}
                      className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-muted-foreground">{t('connection.password')}</label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t('connection.passwordPlaceholder')}
                        className="w-full px-2.5 py-1.5 pr-7 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Database field - shown in general tab for PG-like databases */}
                {(type === "postgresql" || type === "gaussdb") && (
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      {t('connection.database')} <span className="text-destructive">*</span>
                    </label>
                    <input
                      type="text"
                      value={database}
                      onChange={(e) => setDatabase(e.target.value)}
                      placeholder={type === "gaussdb" ? "gaussdb" : "postgres"}
                      className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        );
      
      case "advanced":
        return (
          <div className="space-y-3">
            <div className="space-y-2 p-2.5 bg-muted/30 rounded border border-border/50">
              <label className="text-xs font-medium text-muted-foreground">{t('connection.keepaliveTitle')}</label>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-muted-foreground whitespace-nowrap">{t('connection.keepaliveInterval')}</label>
                <input
                  type="number"
                  value={keepaliveInterval}
                  onChange={(e) => setKeepaliveInterval(Math.max(0, Number(e.target.value)))}
                  min={0}
                  max={600}
                  className="w-16 px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                />
                <span className="text-[11px] text-muted-foreground">{t('connection.seconds')}</span>
                <span className="text-[11px] text-muted-foreground/60">({t('connection.keepaliveHint')})</span>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-muted-foreground">{t('connection.autoReconnect')}</label>
                <button
                  onClick={() => setAutoReconnect(!autoReconnect)}
                  className={`relative w-8 h-4 rounded-full transition-colors ${
                    autoReconnect ? "bg-blue-600" : "bg-muted border border-border"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                      autoReconnect ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Connection pool overrides. Empty = use backend default for this DB type. */}
            <div className="space-y-2 p-2.5 bg-muted/30 rounded border border-border/50">
              <label className="text-xs font-medium text-muted-foreground">{t('connection.poolTitle')}</label>
              <p className="text-[10px] text-muted-foreground/60">{t('connection.poolHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-muted-foreground whitespace-nowrap w-28">{t('connection.poolMaxConnections')}</label>
                  <input
                    type="number"
                    value={poolMaxConnections}
                    onChange={(e) => setPoolMaxConnections(e.target.value)}
                    min={1}
                    max={200}
                    placeholder="auto"
                    className="w-20 px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-muted-foreground whitespace-nowrap w-28">{t('connection.poolAcquireTimeout')}</label>
                  <input
                    type="number"
                    value={poolAcquireTimeoutSecs}
                    onChange={(e) => setPoolAcquireTimeoutSecs(e.target.value)}
                    min={1}
                    max={600}
                    placeholder="auto"
                    className="w-20 px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                  />
                  <span className="text-[10px] text-muted-foreground">s</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-muted-foreground whitespace-nowrap w-28">{t('connection.poolIdleTimeout')}</label>
                  <input
                    type="number"
                    value={poolIdleTimeoutSecs}
                    onChange={(e) => setPoolIdleTimeoutSecs(e.target.value)}
                    min={0}
                    max={86400}
                    placeholder="auto"
                    className="w-20 px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                  />
                  <span className="text-[10px] text-muted-foreground">s</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-muted-foreground whitespace-nowrap w-28">{t('connection.poolMaxLifetime')}</label>
                  <input
                    type="number"
                    value={poolMaxLifetimeSecs}
                    onChange={(e) => setPoolMaxLifetimeSecs(e.target.value)}
                    min={0}
                    max={86400}
                    placeholder="auto"
                    className="w-20 px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                  />
                  <span className="text-[10px] text-muted-foreground">s</span>
                </div>
              </div>
            </div>
          </div>
        );
      
      case "database":
        return (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('connection.database')}</label>
              <input
                type="text"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="(Optional)"
                className="w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
              />
            </div>
          </div>
        );
      
      case "ssl":
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">{t('connection.enableSsl')}</label>
              <button
                onClick={() => setSslEnabled(!sslEnabled)}
                className={`relative w-8 h-4 rounded-full transition-colors ${
                  sslEnabled ? "bg-blue-600" : "bg-muted border border-border"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                    sslEnabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            {sslEnabled && (
              <div className="space-y-2 p-2.5 bg-muted/30 rounded border border-border/50">
                <label className="text-xs font-medium text-muted-foreground">{t('connection.sslCerts')}</label>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">{t('connection.caCert')}</label>
                  <input
                    type="text"
                    value={sslCaCert}
                    onChange={(e) => setSslCaCert(e.target.value)}
                    placeholder="/path/to/ca-cert.pem"
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">{t('connection.clientCert')}</label>
                  <input
                    type="text"
                    value={sslClientCert}
                    onChange={(e) => setSslClientCert(e.target.value)}
                    placeholder="/path/to/client-cert.pem"
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">{t('connection.clientKey')}</label>
                  <input
                    type="text"
                    value={sslClientKey}
                    onChange={(e) => setSslClientKey(e.target.value)}
                    placeholder="/path/to/client-key.pem"
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
              </div>
            )}
          </div>
        );
      
      case "ssh":
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">{t('connection.sshTunnel')}</label>
              <button
                onClick={() => setSshEnabled(!sshEnabled)}
                className={`relative w-8 h-4 rounded-full transition-colors ${
                  sshEnabled ? "bg-blue-600" : "bg-muted border border-border"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                    sshEnabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            {sshEnabled && (
              <div className="space-y-2 p-2.5 bg-muted/30 rounded border border-border/50">
                <div className="flex gap-2">
                  <div className="flex-1 space-y-1">
                    <label className="text-[11px] text-muted-foreground">{t('connection.sshHost')}</label>
                    <input
                      type="text"
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                      placeholder="ssh.example.com"
                      className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                    />
                  </div>
                  <div className="w-20 space-y-1">
                    <label className="text-[11px] text-muted-foreground">{t('connection.sshPort')}</label>
                    <input
                      type="number"
                      value={sshPort}
                      onChange={(e) => setSshPort(Number(e.target.value))}
                      className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">{t('connection.sshUsername')}</label>
                  <input
                    type="text"
                    value={sshUsername}
                    onChange={(e) => setSshUsername(e.target.value)}
                    placeholder="ssh_user"
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">{t('connection.sshPassword')}</label>
                  <input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={t('connection.sshPasswordPlaceholder')}
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">{t('connection.privateKey')}</label>
                  <textarea
                    value={sshPrivateKey}
                    onChange={(e) => setSshPrivateKey(e.target.value)}
                    placeholder={t('connection.privateKeyPlaceholder')}
                    rows={3}
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60 resize-none font-mono"
                  />
                </div>
              </div>
            )}
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-[600px] max-h-[85vh] bg-background border border-border rounded-lg shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Plug size={15} className="text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {editConnection ? t('connection.editTitle') : t('connection.title')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          {TABS.map((tab) => {
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? "text-[hsl(var(--tab-active))] border-b-2 border-[hsl(var(--tab-active))]"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                }`}
              >
                <TabIcon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Form Content */}
        <div className="px-4 py-3 overflow-y-auto flex-1">
          {renderTabContent()}

          {/* Test Result */}
          {testResult && (
            <div
              className={`mt-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs ${
                testResult.success
                  ? "bg-success/10 text-success"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {testResult.success ? <Check size={12} /> : <X size={12} />}
              {testResult.message}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded hover:bg-muted transition-colors disabled:opacity-40"
          >
            {testing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Plug size={12} />
            )}
            {t('connection.testConnection')}
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors disabled:opacity-40"
          >
            {saving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Check size={12} />
            )}
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConnectionDialog;
