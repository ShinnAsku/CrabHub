import { useState, useEffect, useCallback, useMemo } from "react";
import { t } from "@/lib/i18n";
import {
  fetchPluginRegistry, listPlugins, installPlugin, removePlugin,
  enablePlugin, disablePlugin, getAvailableDrivers, type DriverTypeInfo,
} from "@/lib/tauri-commands";
import { showMessage } from "./MessageDialog";
import {
  RefreshCw, Loader2, AlertTriangle, Download, RotateCcw, Check,
  ExternalLink, Settings as SettingsIcon, Trash2, ChevronDown,
  CheckCircle2, Plug, PackageCheck, Power, Boxes, Search, X,
} from "lucide-react";

/* ── Types ── */
interface RegistryPlugin {
  id: string; name: string; description: string; author: string;
  homepage: string; latest_version: string;
  releases: { version: string; min_opendb_version: string; assets: Record<string, string> }[];
  installed_version?: string; update_available?: boolean; enabled?: boolean;
}
type AvailableFilter = "all" | "installed" | "updates";
type CardAccent = "green" | "amber" | "blue" | null;

/* ── Band palette ── */
const BANDS = [
  { bg: "bg-blue-500/10", text: "text-blue-400/40" },
  { bg: "bg-purple-500/10", text: "text-purple-400/40" },
  { bg: "bg-emerald-500/10", text: "text-emerald-400/40" },
  { bg: "bg-rose-500/10", text: "text-rose-400/40" },
  { bg: "bg-cyan-500/10", text: "text-cyan-400/40" },
  { bg: "bg-orange-500/10", text: "text-orange-400/40" },
  { bg: "bg-teal-500/10", text: "text-teal-400/40" },
  { bg: "bg-indigo-500/10", text: "text-indigo-400/40" },
];
function band(name: string) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff; return BANDS[h % BANDS.length]!; }

/* ── PluginCard ── */
function PluginCard({ name, description, version, author, homepage, status, actions, accent, pulse, showBand }: {
  name: string; description: string; version?: string; author?: string;
  homepage?: string; status?: React.ReactNode; actions: React.ReactNode;
  accent?: CardAccent; pulse?: boolean; showBand?: boolean;
}) {
  const b = band(name);
  const authorName = author ? author.split("<")[0]?.trim() ?? author : null;
  const authorUrl = author ? (author.match(/<(https?:\/\/[^>]+)>/) || [])[1] : null;

  return (
    <div className={`group relative flex h-full flex-col rounded-lg bg-card overflow-hidden transition-all duration-200 ease-out hover:-translate-y-px
      ${!accent ? "border border-border hover:border-accent hover:shadow-md" : ""}
      ${accent === "green" ? "border border-border border-l-[3px] border-l-green-500/80 hover:border-accent hover:shadow-lg" : ""}
      ${accent === "amber" ? "border border-border border-l-[3px] border-l-amber-500/80 hover:border-accent hover:shadow-lg" : ""}
      ${accent === "blue" ? "border border-border border-l-[3px] border-l-blue-600/80 hover:border-accent hover:shadow-lg" : ""}`}>
      {showBand && (
        <div className={`flex h-12 shrink-0 items-center justify-center ${b.bg}`}>
          <span className={`select-none text-4xl font-bold leading-none ${b.text}`}>{name.trim().charAt(0).toUpperCase()}</span>
        </div>
      )}
      {pulse && (
        <div className={`absolute z-10 flex h-2 w-2 ${showBand ? "top-1.5 right-1.5" : "top-2.5 right-2.5"}`}>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </div>
      )}
      <div className="flex flex-1 flex-col p-4 gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {homepage ? (
                <a href={homepage} target="_blank" rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-primary hover:underline underline-offset-2">
                  <span className="truncate">{name}</span>
                  <ExternalLink size={11} className="shrink-0 text-muted-foreground" />
                </a>
              ) : (
                <span className="block truncate text-sm font-semibold text-primary">{name}</span>
              )}
              {version && <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">v{version}</span>}
            </div>
            {authorName && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {t('plugin.by')}{" "}
                {authorUrl || homepage ? (
                  <a href={authorUrl || homepage} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">{authorName}</a>
                ) : authorName}
              </p>
            )}
          </div>
          {status && <div className="shrink-0 mt-0.5">{status}</div>}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2 flex-1">{description}</p>
      </div>
      <div className="flex min-h-11 items-center justify-end gap-2 border-t border-border bg-muted/50 px-4 py-2.5">{actions}</div>
    </div>
  );
}

/* ── StatCard ── */
function StatCard({ icon, value, label, colorClass, bgClass, valueColorClass }: {
  icon: React.ReactNode; value: number; label: string; colorClass: string; bgClass: string; valueColorClass?: string;
}) {
  return (
    <div className="p-4 flex items-center gap-3">
      <div className={`p-2.5 rounded-lg shrink-0 ${bgClass} ${colorClass}`}>{icon}</div>
      <div className="min-w-0">
        <div className={`text-2xl font-bold leading-none tabular-nums ${valueColorClass ?? "text-foreground"}`}>{value}</div>
        <div className="text-[10px] text-muted-foreground mt-1 leading-tight truncate">{label}</div>
      </div>
    </div>
  );
}

/* ── PluginToggle ── */
function PluginToggle({ enabled, onToggle, disabled }: { enabled: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onToggle} disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${enabled ? "bg-blue-600" : "bg-muted"} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200 ${enabled ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

/* ── Main Component ── */
const PluginManager: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [registryPlugins, setRegistryPlugins] = useState<RegistryPlugin[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<any[]>([]);
  const [builtinDrivers, setBuiltinDrivers] = useState<DriverTypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<AvailableFilter>("all");

  const load = useCallback(async () => {
    try { setLoading(true); setRegistryError(null);
      const data = await fetchPluginRegistry();
      setRegistryPlugins(Array.isArray(data) ? data : (data?.plugins || []));
      const inst = await listPlugins();
      setInstalledPlugins(Array.isArray(inst) ? inst : (inst?.plugins || []));
      try { const d = await getAvailableDrivers(); setBuiltinDrivers(d.filter(x => x.builtin)); } catch {}
    } catch (err) { console.error(err); setRegistryError(String(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, []);

  const installedIds = useMemo(() => new Set(installedPlugins.map(p => p.id)), [installedPlugins]);
  const isInstalled = (id: string) => installedIds.has(id);
  const getInstalled = (id: string) => installedPlugins.find(p => p.id === id);

  const filtered = useMemo(() => {
    let list = registryPlugins;
    if (activeFilter === "all") list = list.filter(p => !p.installed_version && !isInstalled(p.id));
    else if (activeFilter === "installed") list = list.filter(p => !!p.installed_version || isInstalled(p.id));
    else if (activeFilter === "updates") list = list.filter(p => p.update_available);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    }
    return list;
  }, [registryPlugins, activeFilter, searchQuery, installedPlugins]);

  const updateCount = useMemo(() => registryPlugins.filter(p => p.update_available).length, [registryPlugins]);

  const doInstall = async (pluginId: string, version: string) => {
    try { setInstallingId(pluginId); setRegistryError(null); await installPlugin(pluginId, version); await load(); }
    catch (err) { console.error(err); setRegistryError(t('plugin.installError') + ': ' + String(err)); }
    finally { setInstallingId(null); }
  };

  const doRemove = async (pluginId: string) => {
    try { setRemovingId(pluginId); await showMessage(t('plugin.confirmRemove')); await removePlugin(pluginId); await load(); }
    catch (err) { console.error(err); }
    finally { setRemovingId(null); }
  };

  const doToggle = async (pluginId: string, enabled: boolean) => {
    try { await (enabled ? disablePlugin(pluginId) : enablePlugin(pluginId)); await load(); }
    catch (err) { console.error(err); }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full bg-background">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3"><Plug size={20} className="text-blue-400" /><h2 className="text-lg font-semibold">{t('plugin.title')}</h2></div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted text-muted-foreground" title="Close"><X size={16} /></button>
        </div>
        <div className="flex-1 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400 shrink-0"><Plug size={18} /></div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('plugin.title')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t('plugin.description')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-xs text-muted-foreground hover:text-foreground hover:border-accent transition-colors">
            <RefreshCw size={13} />{t('common.refresh')}
          </button>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-8 p-6">
          {/* Overview panel */}
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="p-5 border-b border-border bg-muted/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400 shrink-0"><Plug size={18} /></div>
                <div>
                  <h2 className="text-lg font-semibold">{t('plugin.title')}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('plugin.description')}</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-border">
              <StatCard icon={<PackageCheck size={15} />} value={builtinDrivers.length + installedPlugins.length}
                label={t('plugin.installed')} colorClass="text-green-400" bgClass="bg-green-500/10" />
              <StatCard icon={<Power size={15} />} value={builtinDrivers.length + installedPlugins.filter(p => p.enabled !== false).length}
                label={t('plugin.enabled')} colorClass="text-blue-400" bgClass="bg-blue-500/10" />
              <StatCard icon={<Boxes size={15} />} value={registryPlugins.length}
                label={t('plugin.registry')} colorClass="text-purple-400" bgClass="bg-purple-500/10" />
              <StatCard icon={<RefreshCw size={15} />} value={updateCount}
                label={t('plugin.updates')} colorClass={updateCount > 0 ? "text-amber-400" : "text-muted-foreground"}
                bgClass={updateCount > 0 ? "bg-amber-500/10" : "bg-muted"} valueColorClass={updateCount > 0 ? "text-amber-400" : undefined} />
            </div>
          </div>

          {/* Error */}
          {registryError && (
            <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
              <AlertTriangle size={16} />{registryError}
            </div>
          )}

          {/* Available section */}
          <div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-3">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('plugin.all')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{t('plugin.description')}</p>
              </div>
              <div className="relative shrink-0">
                <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input type="text" placeholder={t('plugin.search')} value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-44 rounded-lg border border-border bg-card py-1.5 pl-7 pr-3 text-xs placeholder:text-muted-foreground focus:w-56 focus:border-blue-500 focus:outline-none transition-all" />
              </div>
            </div>

            {/* Filter tabs */}
            <div className="flex items-center justify-between border-b border-border">
              <div className="flex items-center gap-0.5">
                {([
                  { id: "all" as const, label: t('plugin.all'), count: registryPlugins.filter(p => !p.installed_version && !isInstalled(p.id)).length },
                  { id: "installed" as const, label: t('plugin.installedTab'), count: builtinDrivers.length + installedPlugins.filter(p => !builtinDrivers.some(d => d.id === p.id)).length },
                  { id: "updates" as const, label: t('plugin.updatesTab'), count: updateCount },
                ]).map(({ id, label, count }) => (
                  <button key={id} type="button" onClick={() => setActiveFilter(id)}
                    className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors -mb-px
                      ${activeFilter === id ? "border-blue-500 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                    {label}
                    {count > 0 && (
                      <span className={`rounded-full px-1.5 py-px text-[9px] font-semibold
                        ${id === "updates" && count > 0 ? "bg-amber-500/20 text-amber-400" : "bg-muted text-muted-foreground"}`}>{count}</span>
                    )}
                  </button>
                ))}
              </div>
              <button onClick={load} className="mb-px flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <RefreshCw size={12} />{t('common.refresh')}
              </button>
            </div>

            {/* Plugin cards */}
            <div className="pt-4">
              {activeFilter === "installed" ? (
                <div className="grid gap-4 xl:grid-cols-2 lg:grid-cols-2 sm:grid-cols-1">
                  {/* Built-in drivers */}
                  {builtinDrivers.filter(d => !searchQuery || d.name.toLowerCase().includes(searchQuery.toLowerCase())).map(driver => (
                    <PluginCard key={driver.id} name={driver.name} description={t('plugin.builtin')} showBand
                      status={<span className="text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-px rounded-md">{t('plugin.builtin')}</span>}
                      actions={<div className="flex items-center gap-1.5 text-xs text-green-600"><CheckCircle2 size={14} />{t('plugin.enabled')}</div>} />
                  ))}
                  {/* Installed plugins */}
                  {installedPlugins.filter(p => !searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase())).map(plugin => {
                    const rp = registryPlugins.find(r => r.id === plugin.id);
                    const enabled = plugin.enabled !== false;
                    return (
                      <PluginCard key={plugin.id} name={plugin.name} description={plugin.description || (rp?.description ?? "")}
                        version={plugin.version} author={rp?.author} homepage={rp?.homepage}
                        accent={enabled ? "blue" : null} showBand
                        status={<PluginToggle enabled={enabled} onToggle={() => doToggle(plugin.id, enabled)} />}
                        actions={
                          <button onClick={() => doRemove(plugin.id)} disabled={removingId === plugin.id}
                            className="p-1.5 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                            title={t('plugin.remove')}>
                            {removingId === plugin.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          </button>
                        } />
                    );
                  })}
                  {builtinDrivers.length === 0 && installedPlugins.length === 0 && (
                    <div className="col-span-2 flex flex-col items-center py-16 text-muted-foreground">
                      <Plug size={40} className="mb-3 opacity-30" /><p className="text-sm">{t('plugin.noInstalled')}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid gap-4 xl:grid-cols-2 lg:grid-cols-2 sm:grid-cols-1">
                  {filtered.map(plugin => {
                    const installed = isInstalled(plugin.id);
                    const ip = getInstalled(plugin.id);
                    const hasUpdate = installed && ip?.version !== plugin.latest_version;
                    const enabled = ip?.enabled !== false;
                    const accent: CardAccent = installed ? (hasUpdate ? "amber" : "green") : null;
                    return (
                      <PluginCard key={plugin.id} name={plugin.name} description={plugin.description}
                        version={installed ? ip?.version : plugin.latest_version}
                        author={plugin.author} homepage={plugin.homepage}
                        accent={accent} pulse={hasUpdate} showBand
                        status={installed ? (
                          <PluginToggle enabled={enabled} onToggle={() => doToggle(plugin.id, enabled)} />
                        ) : null}
                        actions={installed ? (
                          <div className="flex items-center justify-end gap-2 w-full">
                            {hasUpdate && (
                              <button onClick={() => doInstall(plugin.id, plugin.latest_version)} disabled={installingId === plugin.id}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
                                {installingId === plugin.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                                {t('plugin.update')} v{plugin.latest_version}
                              </button>
                            )}
                            <button onClick={() => doRemove(plugin.id)} disabled={removingId === plugin.id}
                              className="p-1.5 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                              title={t('plugin.remove')}>
                              {removingId === plugin.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-2 w-full">
                            <button onClick={() => doInstall(plugin.id, plugin.latest_version)} disabled={installingId === plugin.id}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50">
                              {installingId === plugin.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                              {t('plugin.install')}
                            </button>
                            <div className="flex items-center gap-1 px-2 py-1.5 text-[11px] text-muted-foreground border border-border rounded-lg">
                              <RotateCcw size={9} />v{plugin.latest_version}
                            </div>
                          </div>
                        )} />
                    );
                  })}
                  {filtered.length === 0 && (
                    <div className="col-span-2 flex flex-col items-center py-16 text-muted-foreground">
                      <Boxes size={40} className="mb-3 opacity-30" />
                      <p className="text-sm">{activeFilter === "updates" ? t('plugin.upToDate') : t('plugin.noResults')}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PluginManager;
