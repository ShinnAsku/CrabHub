import React from "react";
import { Save, Play, PlayCircle, X, ChevronLeft, ChevronRight, Settings, List, Hash } from "lucide-react";
import { t } from "@/lib/i18n";

interface NotebookToolbarProps {
  onSave: () => void;
  onRunAll: () => void;
  isRunningAll: boolean;
  onClose: () => void;
}

const NotebookToolbar: React.FC<NotebookToolbarProps> = ({ 
  onSave, 
  onRunAll, 
  isRunningAll, 
  onClose 
}) => {
  return (
    <div className="flex items-center justify-between bg-muted px-4 py-2 border-b border-border">
      <div className="flex items-center space-x-2">
        <button
          onClick={onClose}
          className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
          title={t('notebook.close')}
        >
          <X className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-medium text-foreground">{t('notebook.title')}</h1>
      </div>

      <div className="flex items-center space-x-2">
        <button
          onClick={onRunAll}
          className="flex items-center space-x-2 bg-primary hover:opacity-90 text-primary-foreground px-4 py-2 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isRunningAll}
        >
          {isRunningAll ? (
            <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
          ) : (
            <PlayCircle className="w-4 h-4" />
          )}
          <span>{t('notebook.runAll')}</span>
        </button>
        <button
          onClick={onSave}
          className="flex items-center space-x-2 bg-card hover:bg-accent text-foreground px-4 py-2 rounded-md border border-border transition-colors"
        >
          <Save className="w-4 h-4" />
          <span>{t('notebook.save')}</span>
        </button>
      </div>
    </div>
  );
};

export default NotebookToolbar;