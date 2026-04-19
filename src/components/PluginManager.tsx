import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";
import { invoke } from "@tauri-apps/api/core";
import * as dialog from "@tauri-apps/plugin-dialog";

import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Check,
  ExternalLink,
  ChevronDown,
  X
} from "lucide-react";

// Types
interface RegistryReleaseWithStatus {
  version: string;
  min_tabularis_version: string | null;
  platform_supported: boolean;
}

interface RegistryPluginWithStatus {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage: string;
  latest_version: string;
  releases: RegistryReleaseWithStatus[];
  installed_version: string | null;
  update_available: boolean;
  platform_supported: boolean;
  enabled: boolean;
}

interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  default_port: number | null;
  executable: string;
  enabled: boolean;
  capabilities: {
    schemas: boolean;
    views: boolean;
    routines: boolean;
    file_based: boolean;
    folder_based: boolean | null;
    no_connection_required: boolean | null;
    connection_string: boolean | null;
    connection_string_example: string | null;
    identifier_quote: string;
    alter_primary_key: boolean;
    manage_tables: boolean | null;
    readonly: boolean | null;
  };
  data_types: Array<{
    name: string;
    category: string;
    requires_length: boolean;
    requires_precision: boolean;
    default_length: string | null;
  }>;
  settings: Array<{
    key: string;
    label: string;
    type_: string;
    required: boolean | null;
    description: string | null;
    options: Array<string> | null;
    default: any;
  }> | null;
  ui_extensions: Array<{
    slot: string;
    module: string;
    order: number | null;
    driver: string | null;
  }> | null;
}

// Utils
function parseAuthor(author: string) {
  const match = author.match(/^(.*?)\s*<(.*?)>$/);
  if (match) {
    return { name: match[1], url: match[2] };
  }
  return { name: author, url: null };
}

function versionGte(version: string, minVersion: string) {
  const v1 = version.split('.').map(Number);
  const v2 = minVersion.split('.').map(Number);
  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const n1 = v1[i] || 0;
    const n2 = v2[i] || 0;
    if (n1 > n2) return true;
    if (n1 < n2) return false;
  }
  return true;
}

// Version dropdown component
interface VersionOption {
  version: string;
  isInstalled: boolean;
  isLatest: boolean;
}

function VersionDropdown({
  options,
  value,
  onChange,
  isDowngrade,
  label
}: {
  options: VersionOption[];
  value: string;
  onChange: (v: string) => void;
  isDowngrade: boolean;
  label: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, minWidth: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const updatePos = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({
        top: r.bottom + 4,
        left: r.left,
        minWidth: Math.max(r.width, 160)
      });
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        !btnRef.current?.contains(e.target as Node) &&
        !dropRef.current?.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          updatePos();
          setIsOpen((o) => !o);
        }}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] bg-muted transition-colors cursor-pointer select-none ${
          isDowngrade
            ? "border-amber-500/30 text-amber-400/80 hover:border-amber-500/60 hover:text-amber-400"
            : isOpen
              ? "border-blue-500/60 text-primary"
              : "border-border text-muted-foreground hover:border-blue-500/50 hover:text-primary"
        }`}
      >
        <RotateCcw size={9} />
        <span>{label}</span>
        <ChevronDown
          size={9}
          className={`transition-transform duration-150 ${isOpen && "rotate-180"}`}
        />
      </button>
      {isOpen &&
        createPortal(
          <div
            ref={dropRef}
            style={{
              top: pos.top,
              left: pos.left,
              minWidth: pos.minWidth
            }}
            className="fixed z-[200] bg-card border border-border rounded-lg shadow-xl overflow-hidden"
          >
            {options.map((opt) => (
              <button
                key={opt.version}
                type="button"
                onClick={() => {
                  onChange(opt.version);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                  opt.isInstalled
                    ? "bg-green-100 hover:bg-green-200"
                    : opt.version === value
                      ? "bg-muted"
                      : "hover:bg-muted"
                }`}
              >
                <span className="w-3 shrink-0 flex items-center justify-center">
                  {opt.isInstalled && (
                    <Check size={10} className="text-green-600" />
                  )}
                </span>
                <span className={`font-mono ${opt.isInstalled ? "text-green-600" : "text-primary"}`}>
                  v{opt.version}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  {opt.isInstalled && (
                    <span className="text-[9px] font-medium bg-green-100 text-green-600 px-1.5 py-px rounded">
                      installed
                    </span>
                  )}
                  {opt.isLatest && (
                    <span className="text-[9px] font-medium bg-blue-100 text-blue-600 px-1.5 py-px rounded">
                      latest
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

// Plugin card component
function PluginCard({
  name,
  description,
  version,
  author,
  homepage,
  status,
  actions,
  dimmed
}: {
  name: string;
  description: string;
  version?: string;
  author?: string;
  homepage?: string;
  status?: React.ReactNode;
  actions: React.ReactNode;
  dimmed?: boolean;
}) {
  const parsedAuthor = author ? parseAuthor(author) : null;
  return (
    <div className={`grid grid-cols-[1fr_auto] gap-x-6 px-5 py-4 rounded-xl border border-border bg-card transition-colors hover:border-border ${
      dimmed ? " opacity-50" : ""
    }`}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold text-foreground">
            {name}
            {homepage && (
              <ExternalLink size={10} className="ml-1 text-muted-foreground shrink-0" />
            )}
          </span>
          {version && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-px rounded">
              v{version}
            </span>
          )}
          {status}
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
          {description}
        </p>
        {parsedAuthor && (
          <p className="text-[10px] text-muted-foreground mt-1.5">
            作者: {parsedAuthor.name}
          </p>
        )}
      </div>
      <div className="flex flex-col items-end justify-center gap-2 shrink-0 min-w-[160px]">
        {actions}
      </div>
    </div>
  );
}

// Main plugin manager component
const PluginManager: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [registryPlugins, setRegistryPlugins] = useState<RegistryPluginWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [toggling, setToggling] = useState<string | null>(null);

  // Load plugins function
  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Fetch plugin registry with enhanced status (same as Tabularis)
      const registryPlugins = await invoke<RegistryPluginWithStatus[]>("fetch_plugin_registry");
      
      setRegistryPlugins(registryPlugins);
      
      // Set default selected versions to latest
      const defaultVersions: Record<string, string> = {};
      registryPlugins.forEach(plugin => {
        defaultVersions[plugin.id] = plugin.latest_version;
      });
      setSelectedVersions(defaultVersions);
    } catch (err) {
      setError("Failed to load plugins");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Install plugin function
  const handleInstallPlugin = async (plugin: RegistryPluginWithStatus) => {
    try {
      setInstalling(plugin.id);
      setError(null);
      const selectedVersion = selectedVersions[plugin.id] || plugin.latest_version;
      await invoke("install_plugin", {
        pluginId: plugin.id,
        version: selectedVersion
      });
      await loadPlugins();
    } catch (err) {
      setError(`Failed to install plugin: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    } finally {
      setInstalling(null);
    }
  };

  // Remove plugin function
  const handleRemovePlugin = async (pluginId: string) => {
    try {
      setError(null);
      await dialog.message('确认删除插件？');
      await invoke("remove_plugin", {
        pluginId
      });
      await loadPlugins();
    } catch (err) {
      setError(`Failed to remove plugin: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    }
  };

  // Toggle plugin function
  const handleTogglePlugin = async (pluginId: string, enabled: boolean) => {
    try {
      setToggling(pluginId);
      setError(null);
      if (enabled) {
        await invoke("enable_plugin", {
          pluginId
        });
      } else {
        await invoke("disable_plugin", {
          pluginId
        });
      }
      await loadPlugins();
    } catch (err) {
      setError(`Failed to ${enabled ? 'enable' : 'disable'} plugin: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    } finally {
      setToggling(null);
    }
  };

  // Load plugins on mount
  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between bg-muted px-4 py-2 border-b border-border">
        <div className="flex items-center space-x-2">
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-medium text-foreground">{t('plugin.title')}</h1>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={loadPlugins}
            className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title="Refresh"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-4 p-3 bg-destructive/20 border border-destructive rounded-md">
            <div className="flex items-center">
              <AlertTriangle className="w-4 h-4 text-destructive mr-2" />
              <span className="text-destructive">{error}</span>
            </div>
          </div>
        )}

        <div className="mb-6">
          <h2 className="text-md font-medium text-foreground mb-2">可用插件</h2>
          <p className="text-sm text-muted-foreground mb-4">浏览并安装注册表中的插件。</p>
          
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 size={16} className="animate-spin" />
              加载插件列表中...
            </div>
          )}
          
          {!loading && error && (
            <div className="bg-destructive/20 border border-destructive text-destructive px-4 py-3 rounded-lg text-sm flex items-center gap-2">
              <AlertTriangle size={16} />
              加载插件列表失败: {error}
            </div>
          )}
          
          {!loading && !error && (
            <div className="space-y-3">
              {registryPlugins.map((plugin) => {
                const platformReleases = plugin.releases.filter(r => r.platform_supported);
                const installableReleases = platformReleases.filter(r => r.version !== plugin.installed_version);
                const isAtLatest = !!plugin.installed_version && plugin.installed_version === plugin.latest_version;
                const defaultVer = isAtLatest
                  ? plugin.latest_version
                  : (installableReleases.find(r => r.version === plugin.latest_version)?.version ??
                     installableReleases[0]?.version ??
                     plugin.latest_version);
                const selectedVer = selectedVersions[plugin.id] ?? defaultVer;
                const selectedRelease = plugin.releases.find(r => r.version === selectedVer);
                const selectedPlatformSupported = selectedRelease?.platform_supported ?? false;
                const isSelectedInstalled = plugin.installed_version === selectedVer;
                const minVersion = selectedRelease?.min_tabularis_version ?? null;
                const isCompatible = !minVersion || versionGte('0.1.0', minVersion); // Replace with actual app version
                const isUpdate = !!plugin.installed_version && !isSelectedInstalled;
                const isDowngrade = isUpdate && !versionGte(selectedVer, plugin.installed_version!);
                const showVersionPicker = isAtLatest ? installableReleases.length >= 1 : installableReleases.length > 1;
                const isEnabled = plugin.enabled;

                const versionOptions: VersionOption[] = platformReleases.map(release => ({
                  version: release.version,
                  isInstalled: release.version === plugin.installed_version,
                  isLatest: release.version === plugin.latest_version
                }));

                return (
                  <PluginCard
                    key={plugin.id}
                    name={plugin.name}
                    description={plugin.description}
                    version={plugin.installed_version || undefined}
                    author={plugin.author}
                    homepage={plugin.homepage}
                    status={plugin.installed_version && (
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                        plugin.update_available ? 'bg-yellow-100 text-yellow-600' : 'bg-green-100 text-green-600'
                      }`}>
                        {plugin.update_available ? '可更新' : '已安装'}
                      </span>
                    )}
                    actions={
                      <>
                        {showVersionPicker && (
                          <VersionDropdown
                            options={versionOptions}
                            value={selectedVer}
                            onChange={(v) => setSelectedVersions(prev => ({ ...prev, [plugin.id]: v }))}
                            isDowngrade={isDowngrade}
                            label={`v${selectedVer}`}
                          />
                        )}
                        
                        {plugin.installed_version ? (
                          <>
                            <button
                              onClick={() => handleTogglePlugin(plugin.id, isEnabled)}
                              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                isEnabled
                                  ? 'bg-green-100 text-green-600 hover:bg-green-200'
                                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
                              }`}
                              disabled={toggling === plugin.id}
                            >
                              {toggling === plugin.id ? (
                                <RefreshCw size={12} className="animate-spin" />
                              ) : isEnabled ? (
                                '禁用'
                              ) : (
                                '启用'
                              )}
                            </button>
                            
                            {plugin.update_available && !isSelectedInstalled && (
                              <button
                                onClick={() => handleInstallPlugin(plugin)}
                                className="px-3 py-1.5 bg-primary text-white rounded-md text-xs font-medium hover:bg-primary/90 transition-colors"
                                disabled={installing === plugin.id}
                              >
                                {installing === plugin.id ? (
                                  <RefreshCw size={12} className="animate-spin" />
                                ) : (
                                  `更新到 v${plugin.latest_version}`
                                )}
                              </button>
                            )}
                            
                            {!plugin.update_available && isSelectedInstalled && (
                              <div className="px-3 py-1.5 bg-green-100 text-green-600 rounded-md text-xs font-medium">
                                已是最新版本
                              </div>
                            )}
                            
                            <button
                              onClick={() => handleRemovePlugin(plugin.id)}
                              className="px-3 py-1.5 bg-destructive/10 text-destructive rounded-md text-xs font-medium hover:bg-destructive/20 transition-colors"
                            >
                              删除
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handleInstallPlugin(plugin)}
                            className="px-3 py-1.5 bg-primary text-white rounded-md text-xs font-medium hover:bg-primary/90 transition-colors"
                            disabled={installing === plugin.id}
                          >
                            {installing === plugin.id ? (
                              <RefreshCw size={12} className="animate-spin" />
                            ) : (
                              `安装 v${selectedVer}`
                            )}
                          </button>
                        )}
                      </>
                    }
                    dimmed={!selectedPlatformSupported || !isCompatible}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PluginManager;
