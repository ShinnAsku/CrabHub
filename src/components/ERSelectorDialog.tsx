import { useState, useEffect, useCallback } from "react";
import { Network, X, Loader2 } from "lucide-react";
import { useConnectionStore, useUIStore } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { getSchemas } from "@/lib/tauri-commands";

interface ERSelectorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (connectionId: string, schemaName?: string) => void;
}

function ERSelectorDialog({ isOpen, onClose, onConfirm }: ERSelectorDialogProps) {
  const { connections, activeConnectionId } = useConnectionStore();
  const { selectedSchemaName } = useUIStore();
  const connectedConns = connections.filter((c) => c.connected);

  const [selectedConnId, setSelectedConnId] = useState<string>("");
  const [schemaList, setSchemaList] = useState<string[]>([]);
  const [selectedSchema, setSelectedSchema] = useState<string>("");
  const [loadingSchemas, setLoadingSchemas] = useState(false);

  // Pre-select active connection on open
  useEffect(() => {
    if (isOpen) {
      const initConn = activeConnectionId && connectedConns.find((c) => c.id === activeConnectionId)
        ? activeConnectionId
        : connectedConns[0]?.id || "";
      setSelectedConnId(initConn);
      setSelectedSchema("");
      setSchemaList([]);
    }
  }, [isOpen]);

  // Load schemas when connection changes
  useEffect(() => {
    if (!selectedConnId) {
      setSchemaList([]);
      setSelectedSchema("");
      return;
    }

    const conn = connectedConns.find((c) => c.id === selectedConnId);
    if (!conn) return;

    // SQLite has no schemas
    if (conn.type === "sqlite") {
      setSchemaList([]);
      setSelectedSchema("");
      return;
    }

    let cancelled = false;
    setLoadingSchemas(true);
    getSchemas(selectedConnId)
      .then((schemas) => {
        if (cancelled) return;
        setSchemaList(schemas);
        // Pre-select current schema if available
        if (selectedSchemaName && schemas.includes(selectedSchemaName)) {
          setSelectedSchema(selectedSchemaName);
        } else if (schemas.length > 0) {
          // For PG-like, prefer "public"; for MySQL, pick first
          const pub = schemas.find((s) => s === "public");
          setSelectedSchema(pub || schemas[0] || "");
        }
      })
      .catch(() => {
        if (!cancelled) setSchemaList([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSchemas(false);
      });

    return () => { cancelled = true; };
  }, [selectedConnId]);

  const handleConfirm = useCallback(() => {
    if (!selectedConnId) return;
    const conn = connectedConns.find((c) => c.id === selectedConnId);
    const schema = conn?.type === "sqlite" ? undefined : selectedSchema || undefined;
    onConfirm(selectedConnId, schema);
  }, [selectedConnId, selectedSchema, connectedConns, onConfirm]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-[380px]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Network size={14} className="text-foreground" />
            <span className="text-sm font-medium text-foreground">{t('er.selectTitle')}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-4">
          {connectedConns.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t('er.noConnections')}
            </div>
          ) : (
            <>
              {/* Connection selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('er.selectConnection')}</label>
                <select
                  value={selectedConnId}
                  onChange={(e) => setSelectedConnId(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                >
                  <option value="" disabled>{t('er.selectConnection')}</option>
                  {connectedConns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.type})
                    </option>
                  ))}
                </select>
              </div>

              {/* Schema/Database selector */}
              {selectedConnId && (() => {
                const conn = connectedConns.find((c) => c.id === selectedConnId);
                if (conn?.type === "sqlite") return null;
                return (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">{t('er.selectSchema')}</label>
                    {loadingSchemas ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                        <Loader2 size={12} className="animate-spin" />
                        <span>{t('common.loading')}</span>
                      </div>
                    ) : (
                      <select
                        value={selectedSchema}
                        onChange={(e) => setSelectedSchema(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                        disabled={schemaList.length === 0}
                      >
                        {schemaList.length === 0 && <option value="">{t('er.selectSchema')}</option>}
                        {schemaList.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedConnId || (loadingSchemas)}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
          >
            {t('common.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ERSelectorDialog;
