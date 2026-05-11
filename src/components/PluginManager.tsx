import React, { useState, useEffect, useCallback } from "react";
import { t } from "@/lib/i18n";
import {
  fetchPluginRegistry,
  listPlugins,
  installPlugin,
  removePlugin,
  enablePlugin,
  disablePlugin,
} from "@/lib/tauri-commands";
import * as dialog from "@tauri-apps/plugin-dialog";

import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  X,
  Search,
  Download,
  Trash2,
  Power,
  PowerOff,
  CheckCircle,
  Package,
  ChevronDown,
  ExternalLink,
  RotateCcw
} from "lucide-react";

// Types
interface RegistryRelease {
  version: string;
  min_tabularis_version: string | null;
  assets: Record<string, string>;
  platform_supported?: boolean;
}

interface RegistryPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage: string;
  latest_version: string;
  releases: RegistryRelease[];
  installed_version?: string;
  update_available?: boolean;
  platform_supported?: boolean;
  enabled?: boolean;
}

interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
}

// Tabs
type TabType = "available" | "installed" | "updates";

// Main plugin manager component
const PluginManager: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [availablePlugins, setAvailablePlugins] = useState<RegistryPlugin[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<TabType>("available");

  // Load plugins function
  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Fetch plugin registry
      const registryData = await fetchPluginRegistry();
      const registry = Array.isArray(registryData) ? registryData : (registryData?.plugins || []);
      setAvailablePlugins(registry);
      
      // Load installed plugins
      const installed = await listPlugins();
      const installedPluginsData = Array.isArray(installed) 
        ? installed 
        : (typeof installed === 'object' && installed && 'plugins' in installed 
          ? (installed as any).plugins 
          : []);
      setInstalledPlugins(installedPluginsData);
    } catch (err) {
      console.error("Failed to load plugins:", err);
      setError(t('plugin.loadError') || "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Install plugin function
  const handleInstallPlugin = async (plugin: RegistryPlugin, version?: string) => {
    try {
      setInstalling(plugin.id);
      setError(null);
      await installPlugin(plugin.id, version || plugin.latest_version);
      await loadPlugins();
    } catch (err) {
      console.error("Failed to install plugin:", err);
      setError(t('plugin.installError') || "Failed to install plugin");
    } finally {
      setInstalling(null);
    }
  };

  // Remove plugin function
  const handleRemovePlugin = async (pluginId: string) => {
    try {
      setRemoving(pluginId);
      setError(null);
      await dialog.message(t('plugin.confirmRemove') || "Are you sure you want to remove this plugin?");
      await removePlugin(pluginId);
      await loadPlugins();
    } catch (err) {
      console.error("Failed to remove plugin:", err);
      setError(t('plugin.removeError') || "Failed to remove plugin");
    } finally {
      setRemoving(null);
    }
  };

  // Toggle plugin function
  const handleTogglePlugin = async (pluginId: string, enabled: boolean) => {
    try {
      setToggling(pluginId);
      setError(null);
      if (enabled) {
        await disablePlugin(pluginId);
      } else {
        await enablePlugin(pluginId);
      }
      await loadPlugins();
    } catch (err) {
      console.error("Failed to toggle plugin:", err);
      setError(t('plugin.toggleError') || "Failed to toggle plugin");
    } finally {
      setToggling(null);
    }
  };

  // Filter plugins based on search query
  const filteredAvailablePlugins = availablePlugins.filter(
    plugin => 
      (plugin.name && plugin.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (plugin.description && plugin.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (plugin.author && plugin.author.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredInstalledPlugins = installedPlugins.filter(
    plugin => 
      (plugin.name && plugin.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (plugin.description && plugin.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredUpdatePlugins = availablePlugins.filter(
    plugin => {
      const installed = installedPlugins.find(p => p.id === plugin.id);
      return installed && installed.version !== plugin.latest_version;
    }
  );

  // Load plugins on mount
  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  // Check if plugin is installed
  const isInstalled = (pluginId: string) => {
    return installedPlugins.some(p => p.id === pluginId);
  };

  // Get installed version of plugin
  const getInstalledVersion = (pluginId: string) => {
    const plugin = installedPlugins.find(p => p.id === pluginId);
    return plugin?.version;
  };

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div className="bg-muted px-6 py-4 border-b border-border">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Package size={24} className="text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold">{t('plugin.title')}</h1>
              <p className="text-muted-foreground text-sm">
                {t('plugin.description') || "Install extensions, manage drivers, and control runtime settings."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadPlugins}
              className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
              disabled={loading}
            >
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
              {t('common.refresh') || "Refresh"}
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-card p-4 rounded-xl border border-border">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg">
                <Package size={20} className="text-green-600 dark:text-green-400" />
              </div>
              <div>
                <div className="text-2xl font-bold">{installedPlugins.length + 4}</div>
                <div className="text-sm text-muted-foreground">{t('plugin.installed') || "Installed"}</div>
              </div>
            </div>
          </div>
          <div className="bg-card p-4 rounded-xl border border-border">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                <Power size={20} className="text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <div className="text-2xl font-bold">{installedPlugins.filter(p => p.enabled).length + 4}</div>
                <div className="text-sm text-muted-foreground">{t('plugin.enabled') || "Enabled"}</div>
              </div>
            </div>
          </div>
          <div className="bg-card p-4 rounded-xl border border-border">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
                <Package size={20} className="text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <div className="text-2xl font-bold">{availablePlugins.length}</div>
                <div className="text-sm text-muted-foreground">{t('plugin.registry') || "Registry"}</div>
              </div>
            </div>
          </div>
          <div className="bg-card p-4 rounded-xl border border-border">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-muted rounded-lg">
                <RefreshCw size={20} className="text-muted-foreground" />
              </div>
              <div>
                <div className="text-2xl font-bold">{filteredUpdatePlugins.length}</div>
                <div className="text-sm text-muted-foreground">{t('plugin.updates') || "Updates"}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Search and tabs */}
        <div className="p-4 border-b border-border bg-background/50">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <Search size={16} className="text-muted-foreground" />
              <input
                type="text"
                placeholder={t('plugin.search') || "Search plugins..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-4 border-b border-border -mx-4 -mb-4 px-4 pb-0">
            {[
              { key: "available", label: t('plugin.all') || "All", count: filteredAvailablePlugins.length },
              { key: "installed", label: t('plugin.installedTab') || "Installed", count: filteredInstalledPlugins.length + 4 },
              { key: "updates", label: t('plugin.updatesTab') || "Updates", count: filteredUpdatePlugins.length }
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as TabType)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key 
                    ? "text-primary border-primary" 
                    : "text-muted-foreground border-transparent hover:text-foreground"
                }`}
              >
                {tab.label}
                <span className="px-2 py-0.5 bg-muted rounded-full text-xs">{tab.count}</span>
              </button>
            ))}
            <div className="flex-1" />
            <button
              onClick={loadPlugins}
              className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              disabled={loading}
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              {t('common.refresh') || "Refresh"}
            </button>
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="mx-4 my-4 p-4 bg-destructive/10 border border-destructive rounded-lg">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-destructive" />
              <span className="text-destructive">{error}</span>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 size={20} className="animate-spin" />
              <span>{t('plugin.loading') || "Loading plugins..."}</span>
            </div>
          </div>
        )}

        {/* Plugin list */}
        {!loading && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 gap-4">
              {activeTab === "available" && (
                <>
                  {filteredAvailablePlugins.map((plugin) => {
                    const installed = isInstalled(plugin.id);
                    const installedVersion = getInstalledVersion(plugin.id);
                    const hasUpdate = installed && installedVersion !== plugin.latest_version;

                    return (
                      <div
                        key={plugin.id}
                        className="bg-card border border-border rounded-xl overflow-hidden hover:border-border/80 transition-colors"
                      >
                        <div className="h-12 bg-gradient-to-r from-primary/20 to-primary/5 border-b border-border" />
                        <div className="p-5">
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-lg">{plugin.name}</h3>
                                {plugin.homepage && (
                                  <a
                                    href={plugin.homepage}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-muted-foreground hover:text-foreground"
                                  >
                                    <ExternalLink size={14} />
                                  </a>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {t('plugin.by') || "by"} {plugin.author}
                              </p>
                            </div>
                          </div>

                          <p className="text-muted-foreground mb-4 line-clamp-2">
                            {plugin.description}
                          </p>

                          <div className="flex items-center gap-2 pt-3 border-t border-border">
                            {installed ? (
                              <>
                                <button
                                  onClick={() => handleTogglePlugin(plugin.id, !installedPlugins.find(p => p.id === plugin.id)?.enabled)}
                                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                                  disabled={toggling === plugin.id}
                                >
                                  {toggling === plugin.id ? (
                                    <RefreshCw size={16} className="animate-spin" />
                                  ) : installedPlugins.find(p => p.id === plugin.id)?.enabled ? (
                                    <Power size={16} />
                                  ) : (
                                    <PowerOff size={16} />
                                  )}
                                  {installedPlugins.find(p => p.id === plugin.id)?.enabled 
                                    ? (t('plugin.disable') || "Disable") 
                                    : (t('plugin.enable') || "Enable")}
                                </button>
                                {hasUpdate && (
                                  <button
                                    onClick={() => handleInstallPlugin(plugin)}
                                    className="flex items-center justify-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                                    disabled={installing === plugin.id}
                                  >
                                    {installing === plugin.id ? (
                                      <RefreshCw size={16} className="animate-spin" />
                                    ) : (
                                      <Download size={16} />
                                    )}
                                    {t('plugin.update') || "Update"}
                                  </button>
                                )}
                                <button
                                  onClick={() => handleRemovePlugin(plugin.id)}
                                  className="p-2 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                                  disabled={removing === plugin.id}
                                >
                                  {removing === plugin.id ? (
                                    <Loader2 size={16} className="animate-spin" />
                                  ) : (
                                    <Trash2 size={16} />
                                  )}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleInstallPlugin(plugin)}
                                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                                  disabled={installing === plugin.id}
                                >
                                  {installing === plugin.id ? (
                                    <RefreshCw size={16} className="animate-spin" />
                                  ) : (
                                    <Download size={16} />
                                  )}
                                  {t('plugin.install') || "Install"} v{plugin.latest_version}
                                </button>
                                {/* Version dropdown placeholder */}
                                <button
                                  className="flex items-center gap-1 px-3 py-2 border border-border rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  <RotateCcw size={14} />
                                  v{plugin.latest_version}
                                  <ChevronDown size={14} />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {filteredAvailablePlugins.length === 0 && (
                    <div className="col-span-2 flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Package size={48} className="mb-4 opacity-50" />
                      <p>{t('plugin.noResults') || "No plugins found"}</p>
                    </div>
                  )}
                </>
              )}

              {activeTab === "installed" && (
                <>
                  {/* Built-in plugins */}
                  <div className="col-span-2 mb-2 text-sm font-medium text-muted-foreground">
                    {t('plugin.builtin') || "Built-in"}
                  </div>
                  {[
                    { id: "postgres", name: "PostgreSQL", description: "PostgreSQL databases", version: "1.0.0" },
                    { id: "mysql", name: "MySQL", description: "MySQL and MariaDB databases", version: "1.0.0" },
                    { id: "sqlite", name: "SQLite", description: "SQLite file-based databases", version: "1.0.0" },
                    { id: "gaussdb", name: "GaussDB", description: "GaussDB databases", version: "1.0.0" }
                  ].map((plugin) => (
                    <div
                      key={plugin.id}
                      className="bg-card border border-border rounded-xl overflow-hidden hover:border-border/80 transition-colors"
                    >
                      <div className="h-12 bg-gradient-to-r from-blue-500/20 to-blue-500/5 border-b border-border" />
                      <div className="p-5">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-lg">{plugin.name}</h3>
                              <span className="text-xs px-2 py-0.5 bg-muted rounded-full">
                                v{plugin.version}
                              </span>
                              <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full">
                                Built-in
                              </span>
                            </div>
                          </div>
                        </div>
                        <p className="text-muted-foreground mb-4">{plugin.description}</p>
                        <div className="flex items-center gap-2 pt-3 border-t border-border">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <CheckCircle size={16} className="text-green-600" />
                            {t('plugin.enabled') || "Enabled"}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Installed plugins */}
                  {filteredInstalledPlugins.length > 0 && (
                    <div className="col-span-2 mb-2 mt-4 text-sm font-medium text-muted-foreground">
                      {t('plugin.installed') || "Installed"}
                    </div>
                  )}
                  {filteredInstalledPlugins.map((plugin) => (
                    <div
                      key={plugin.id}
                      className="bg-card border border-border rounded-xl overflow-hidden hover:border-border/80 transition-colors"
                    >
                      <div className="h-12 bg-gradient-to-r from-green-500/20 to-green-500/5 border-b border-border" />
                      <div className="p-5">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-lg">{plugin.name}</h3>
                              <span className="text-xs px-2 py-0.5 bg-muted rounded-full">
                                v{plugin.version}
                              </span>
                            </div>
                          </div>
                        </div>
                        <p className="text-muted-foreground mb-4">{plugin.description}</p>
                        <div className="flex items-center gap-2 pt-3 border-t border-border">
                          <button
                            onClick={() => handleTogglePlugin(plugin.id, plugin.enabled)}
                            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                            disabled={toggling === plugin.id}
                          >
                            {toggling === plugin.id ? (
                              <RefreshCw size={16} className="animate-spin" />
                            ) : plugin.enabled ? (
                              <Power size={16} />
                            ) : (
                              <PowerOff size={16} />
                            )}
                            {plugin.enabled 
                              ? (t('plugin.disable') || "Disable") 
                              : (t('plugin.enable') || "Enable")}
                          </button>
                          <button
                            onClick={() => handleRemovePlugin(plugin.id)}
                            className="p-2 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                            disabled={removing === plugin.id}
                          >
                            {removing === plugin.id ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <Trash2 size={16} />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  
                  {filteredInstalledPlugins.length === 0 && (
                    <div className="col-span-2 flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Package size={48} className="mb-4 opacity-50" />
                      <p>{t('plugin.noInstalled') || "No installed plugins"}</p>
                    </div>
                  )}
                </>
              )}

              {activeTab === "updates" && (
                <>
                  {filteredUpdatePlugins.map((plugin) => {
                    const installedVersion = getInstalledVersion(plugin.id);
                    return (
                      <div
                        key={plugin.id}
                        className="bg-card border border-border rounded-xl overflow-hidden hover:border-border/80 transition-colors"
                      >
                        <div className="h-12 bg-gradient-to-r from-orange-500/20 to-orange-500/5 border-b border-border" />
                        <div className="p-5">
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-lg">{plugin.name}</h3>
                                <span className="text-xs px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-full">
                                  {t('plugin.updateAvailable') || "Update available"}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                                <span className="line-through">v{installedVersion}</span>
                                <span>→</span>
                                <span className="text-foreground font-medium">v{plugin.latest_version}</span>
                              </div>
                            </div>
                          </div>
                          <p className="text-muted-foreground mb-4">{plugin.description}</p>
                          <div className="flex items-center gap-2 pt-3 border-t border-border">
                            <button
                              onClick={() => handleInstallPlugin(plugin)}
                              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                              disabled={installing === plugin.id}
                            >
                              {installing === plugin.id ? (
                                <RefreshCw size={16} className="animate-spin" />
                              ) : (
                                <Download size={16} />
                              )}
                              {t('plugin.updateNow') || "Update now"}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  
                  {filteredUpdatePlugins.length === 0 && (
                    <div className="col-span-2 flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <CheckCircle size={48} className="mb-4 opacity-50 text-green-600" />
                      <p>{t('plugin.upToDate') || "All plugins are up to date"}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PluginManager;
