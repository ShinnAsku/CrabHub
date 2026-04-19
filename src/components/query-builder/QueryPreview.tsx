import React, { useState, useCallback } from "react";
import { Eye, Code } from "lucide-react";
import { t } from "@/lib/i18n";

interface QueryPreviewProps {
  sql: string;
  onSqlChange: (sql: string) => void;
}

const QueryPreview: React.FC<QueryPreviewProps> = ({ sql, onSqlChange }) => {
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editedSql, setEditedSql] = useState<string>(sql);

  const handleEditToggle = useCallback(() => {
    if (isEditing) {
      onSqlChange(editedSql);
    } else {
      setEditedSql(sql);
    }
    setIsEditing(!isEditing);
  }, [isEditing, sql, editedSql, onSqlChange]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <Eye className="w-4 h-4 text-success" />
          <h3 className="font-medium text-foreground">{t('builder.sqlPreview')}</h3>
        </div>
        <button
          onClick={handleEditToggle}
          className="flex items-center space-x-1 text-sm bg-card hover:bg-accent text-foreground px-2 py-1 rounded border border-border transition-colors"
        >
          <Code className="w-3 h-3" />
          <span>{isEditing ? t('common.save') : t('common.edit')}</span>
        </button>
      </div>

      <div className="flex-1 bg-card rounded-lg border border-border overflow-hidden">
        {isEditing ? (
          <textarea
            value={editedSql}
            onChange={(e) => setEditedSql(e.target.value)}
            className="w-full h-full p-4 bg-background text-foreground font-mono text-sm resize-none focus:outline-none border border-border"
            placeholder="Enter SQL query here..."
          />
        ) : (
          <pre className="p-4 text-foreground font-mono text-sm overflow-auto">
            {sql}
          </pre>
        )}
      </div>

      <div className="mt-4 text-sm text-muted-foreground">
        <p>{t('builder.sqlPreview')}. {t('common.click')} "{t('common.edit')}" {t('builder.toModifyManually')}.</p>
      </div>
    </div>
  );
};

export default QueryPreview;