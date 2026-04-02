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
} from "lucide-react";
import { useAppStore, type Connection, type ConnectionConfig } from "@/stores/app-store";
import { connectDatabase, disconnectDatabase, testConnection } from "@/lib/tauri-commands";
import { t } from "@/lib/i18n";

interface ConnectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  editConnection?: Connection;
}

const DB_TYPES: { value: Connection["type"]; label: string; port: number; color: string }[] = [
  { value: "postgresql", label: "PostgreSQL", port: 5432, color: "#336791" },
  { value: "mysql", label: "MySQL", port: 3306, color: "#4479A1" },
  { value: "sqlite", label: "SQLite", port: 0, color: "#44A05E" },
  { value: "mssql", label: "MSSQL", port: 1433, color: "#CC2927" },
  { value: "gaussdb", label: "GaussDB", port: 5432, color: "#1E3A5F" },
  { value: "clickhouse", label: "ClickHouse", port: 8123, color: "#FFCC00" },
];

const TABS = [
  { id: "general", label: t('connection.tabGeneral'), icon: Globe },
  { id: "advanced", label: t('connection.tabAdvanced'), icon: Settings },
  { id: "database", label: t('connection.tabDatabase'), icon: Database },
  { id: "ssl", label: "SSL", icon: Lock },
  { id: "ssh", label: "SSH", icon: Server },
];

function ConnectionDialog({ isOpen, onClose, editConnection }: ConnectionDialogProps) {
  const { addConnection, updateConnection, setActiveConnection } = useAppStore();

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

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const isSQLite = type === "sqlite";

  // Populate form when editing
  useEffect(() => {
    if (isOpen) {
      if (editConnection) {
        setName(editConnection.name);
        setType(editConnection.type);
        setHost(editConnection.host);
        setPort(editConnection.port);
        setUsername(editConnection.username);
        setDatabase(editConnection.database || "");
        setSslEnabled(editConnection.sslEnabled);
        setKeepaliveInterval(editConnection.keepaliveInterval ?? 30);
        setAutoReconnect(editConnection.autoReconnect ?? true);
      } else {
        resetForm();
      }
    }
  }, [editConnection, isOpen]);

  // Auto-fill port when type changes
  useEffect(() => {
    if (!editConnection) {
      const dbType = DB_TYPES.find((d) => d.value === type);
      if (dbType) {
        setPort(dbType.port);
        // Set default username based on database type
        if (type === "clickhouse") {
          setUsername("default");
        } else if (type === "gaussdb") {
          setUsername("gaussdb");
        } else if (type === "postgresql") {
          setUsername("postgres");
        } else {
          setUsername("root");
        }
      }
    }
  }, [type, editConnection]);

  // Set default values for new connections
  useEffect(() => {
    if (isOpen && !editConnection) {
      setActiveTab("general");
      setName("");
      setType("postgresql");
      setHost("localhost");
      setPort(5432);
      setUsername("postgres");
      setPassword("root");
      setDatabase("");
      setSslEnabled(false);
      setFilePath("");
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
    }
  }, [isOpen, editConnection]);

  const resetForm = () => {
    setActiveTab("general");
    setName("");
    setType("postgresql");
    setHost("localhost");
    setPort(5432);
    setUsername("postgres");
    setPassword("root");
    setShowPassword(false);
    setDatabase("");
    setSslEnabled(false);
    setFilePath("");
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
        sslEnabled,
        keepaliveInterval,
        autoReconnect,
        filePath: isSQLite ? filePath : undefined,
      };
      console.log("Testing connection with config:", config);
      const success = await testConnection(config);
      console.log("Connection test result:", success);
      setTestResult({
        success,
        message: success ? t('connection.testSuccess') : t('connection.testFailed'),
      });
    } catch (err) {
      console.error("Connection test error:", err);
      const errorMessage = err instanceof Error ? err.message : JSON.stringify(err);
      setTestResult({
        success: false,
        message: errorMessage || t('connection.testError'),
      });
    } finally {
      setTesting(false);
    }
  }, [name, type, host, port, username, password, database, sslEnabled, filePath, isSQLite, keepaliveInterval, autoReconnect]);



  const handleBrowse = async () => {
    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "SQLite Database", extensions: ["db", "sqlite", "sqlite3"] }],
        });
        if (selected) {
          setFilePath(selected as string);
          // Auto-fill name from filename
          if (!name) {
            const filename = (selected as string).split(/[/\\]/).pop() || "";
            setName(filename.replace(/\.(db|sqlite|sqlite3)$/, ""));
          }
        }
      } catch {
        // Fallback: just use input
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const newId = editConnection?.id || crypto.randomUUID();
      const connectionName = name.trim() || `Connection ${new Date().toLocaleTimeString()}`;
      const config: ConnectionConfig = {
            id: newId,
            name: connectionName,
            type,
            host: isSQLite ? "" : host,
            port: isSQLite ? 0 : port,
            username: isSQLite ? "" : username,
            password: isSQLite ? "" : password,
            database: isSQLite ? filePath : (database.trim() || undefined),
            sslEnabled,
            keepaliveInterval,
            autoReconnect,
            filePath: isSQLite ? filePath : undefined,
        };

      const dbType = DB_TYPES.find((d) => d.value === type);

      if (editConnection) {
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
          sslEnabled,
          keepaliveInterval,
          autoReconnect,
          color: dbType?.color || "#666",
        });
      } else {
        // Try to connect
        let connected = false;
        try {
          await connectDatabase(config);
          connected = true;
        } catch {
          // Save without connecting
        }
        addConnection({
          id: newId,
          name: connectionName,
          type,
          host: isSQLite ? "" : host,
          port: isSQLite ? 0 : port,
          username: isSQLite ? "" : username,
          password: isSQLite ? "" : password,
          database: isSQLite ? filePath : (database.trim() || undefined),
          sslEnabled,
          keepaliveInterval,
          autoReconnect,
          connected,
          color: dbType?.color || "#666",
        });
        if (connected) {
          setActiveConnection(newId);
        }
      }

      onClose();
      resetForm();
    } finally {
      setSaving(false);
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
                  className="w-full appearance-none px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground cursor-pointer pr-8"
                >
                  {DB_TYPES.map((db) => (
                    <option key={db.value} value={db.value}>
                      {db.label}
                    </option>
                  ))}
                </select>
                <Database
                  size={12}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                  style={{ color: DB_TYPES.find((d) => d.value === type)?.color }}
                />
              </div>
            </div>

            {/* SQLite file path */}
            {isSQLite ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('connection.filePath')}</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                    placeholder="/path/to/database.db"
                    className="flex-1 px-2.5 py-1.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] transition-colors text-foreground placeholder:text-muted-foreground/60"
                  />
                  <button
                    onClick={handleBrowse}
                    className="p-1.5 bg-muted border border-border rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title={t('connection.browse')}
                  >
                    <FolderOpen size={13} />
                  </button>
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
                      placeholder={type === "clickhouse" ? "default" : type === "gaussdb" ? "gaussdb" : type === "postgresql" ? "postgres" : "root"}
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
                <label className="text-[10px] text-muted-foreground whitespace-nowrap">{t('connection.keepaliveInterval')}</label>
                <input
                  type="number"
                  value={keepaliveInterval}
                  onChange={(e) => setKeepaliveInterval(Math.max(0, Number(e.target.value)))}
                  min={0}
                  max={600}
                  className="w-16 px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                />
                <span className="text-[10px] text-muted-foreground">{t('connection.seconds')}</span>
                <span className="text-[10px] text-muted-foreground/60">({t('connection.keepaliveHint')})</span>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-muted-foreground">{t('connection.autoReconnect')}</label>
                <button
                  onClick={() => setAutoReconnect(!autoReconnect)}
                  className={`relative w-8 h-4 rounded-full transition-colors ${
                    autoReconnect ? "bg-[hsl(var(--tab-active))]" : "bg-muted border border-border"
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
                  sslEnabled ? "bg-[hsl(var(--tab-active))]" : "bg-muted border border-border"
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
                  <label className="text-[10px] text-muted-foreground">{t('connection.caCert')}</label>
                  <input
                    type="text"
                    value={sslCaCert}
                    onChange={(e) => setSslCaCert(e.target.value)}
                    placeholder="/path/to/ca-cert.pem"
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">{t('connection.clientCert')}</label>
                  <input
                    type="text"
                    value={sslClientCert}
                    onChange={(e) => setSslClientCert(e.target.value)}
                    placeholder="/path/to/client-cert.pem"
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">{t('connection.clientKey')}</label>
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
                  sshEnabled ? "bg-[hsl(var(--tab-active))]" : "bg-muted border border-border"
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
                    <label className="text-[10px] text-muted-foreground">{t('connection.sshHost')}</label>
                    <input
                      type="text"
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                      placeholder="ssh.example.com"
                      className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                    />
                  </div>
                  <div className="w-20 space-y-1">
                    <label className="text-[10px] text-muted-foreground">{t('connection.sshPort')}</label>
                    <input
                      type="number"
                      value={sshPort}
                      onChange={(e) => setSshPort(Number(e.target.value))}
                      className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">{t('connection.sshUsername')}</label>
                  <input
                    type="text"
                    value={sshUsername}
                    onChange={(e) => setSshUsername(e.target.value)}
                    placeholder="ssh_user"
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">{t('connection.sshPassword')}</label>
                  <input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={t('connection.sshPasswordPlaceholder')}
                    className="w-full px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">{t('connection.privateKey')}</label>
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
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[hsl(var(--tab-active))] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-40"
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
