import { useState, useEffect, useCallback } from "react";
import { Code2, Plus, Trash2, X } from "lucide-react";
import { t } from "@/lib/i18n";

interface Snippet {
  id: string;
  name: string;
  sql: string;
  isCustom: boolean;
}

function getDefaultSnippets(): Snippet[] {
  return [
    {
      id: "select",
      name: t('snippet.selectQuery'),
      sql: `SELECT \n  column1, column2, column3\nFROM table_name\nWHERE condition = value\nORDER BY column1 ASC\nLIMIT 100;`,
      isCustom: false,
    },
    {
      id: "insert",
      name: t('snippet.insertQuery'),
      sql: `INSERT INTO table_name (column1, column2, column3)\nVALUES (value1, value2, value3);`,
      isCustom: false,
    },
    {
      id: "update",
      name: t('snippet.updateQuery'),
      sql: `UPDATE table_name\nSET column1 = value1,\n    column2 = value2\nWHERE condition = value;`,
      isCustom: false,
    },
    {
      id: "delete",
      name: t('snippet.deleteQuery'),
      sql: `DELETE FROM table_name\nWHERE condition = value;`,
      isCustom: false,
    },
    {
      id: "create_table",
      name: "CREATE TABLE",
      sql: `CREATE TABLE table_name (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);`,
      isCustom: false,
    },
    {
      id: "create_index",
      name: "CREATE INDEX",
      sql: `CREATE INDEX idx_table_column ON table_name (column_name);`,
      isCustom: false,
    },
    {
      id: "alter_table",
      name: "ALTER TABLE",
      sql: `ALTER TABLE table_name\nADD COLUMN new_column VARCHAR(255);`,
      isCustom: false,
    },
  ];
}

interface SnippetPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onInsert: (sql: string) => void;
}

function SnippetPanel({ isOpen, onClose, onInsert }: SnippetPanelProps) {
  const [snippets, setSnippets] = useState<Snippet[]>(getDefaultSnippets);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSql, setNewSql] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("crabhub-custom-snippets");
      if (saved) {
        const custom: Snippet[] = JSON.parse(saved).map((s: any, i: number) => ({
          ...s,
          id: `custom-${i}`,
          isCustom: true,
        }));
        setSnippets([...getDefaultSnippets(), ...custom]);
      }
    } catch {
      // ignore
    }
  }, []);

  const saveCustomSnippets = useCallback((updated: Snippet[]) => {
    const custom = updated.filter((s) => s.isCustom);
    try {
      localStorage.setItem("crabhub-custom-snippets", JSON.stringify(custom));
    } catch {
      // ignore
    }
  }, []);

  const handleAdd = useCallback(() => {
    if (!newName.trim() || !newSql.trim()) return;
    const newSnippet: Snippet = {
      id: `custom-${Date.now()}`,
      name: newName.trim(),
      sql: newSql.trim(),
      isCustom: true,
    };
    const updated = [...snippets, newSnippet];
    setSnippets(updated);
    saveCustomSnippets(updated);
    setNewName("");
    setNewSql("");
    setShowAdd(false);
  }, [newName, newSql, snippets, saveCustomSnippets]);

  const handleDelete = useCallback(
    (id: string) => {
      const updated = snippets.filter((s) => s.id !== id);
      setSnippets(updated);
      saveCustomSnippets(updated);
    },
    [snippets, saveCustomSnippets]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[500px] max-h-[70vh] bg-background border border-border rounded-lg shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Code2 size={14} className="text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{t('snippet.title')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
            >
              <Plus size={12} />
              {t('snippet.add')}
            </button>
            <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Add form */}
        {showAdd && (
          <div className="px-4 py-2 border-b border-border space-y-2 shrink-0">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('snippet.namePlaceholder')}
              className="w-full px-2 py-1 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60"
            />
            <textarea
              value={newSql}
              onChange={(e) => setNewSql(e.target.value)}
              placeholder={t('snippet.contentPlaceholder')}
              rows={3}
              className="w-full px-2 py-1 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground placeholder:text-muted-foreground/60 resize-none font-mono"
            />
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || !newSql.trim()}
              className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-40"
            >
              {t('common.save')}
            </button>
          </div>
        )}

        {/* Snippet list */}
        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex flex-col gap-1">
            {snippets.map((snippet) => (
              <div
                key={snippet.id}
                className="flex items-center gap-2 p-2 rounded hover:bg-muted transition-colors group cursor-pointer"
                onClick={() => {
                  onInsert(snippet.sql);
                  onClose();
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-foreground">{snippet.name}</div>
                  <pre className="text-[10px] text-muted-foreground mt-0.5 truncate font-mono">
                    {snippet.sql.split("\n")[0]}
                  </pre>
                </div>
                {snippet.isCustom && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(snippet.id);
                    }}
                    className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SnippetPanel;
