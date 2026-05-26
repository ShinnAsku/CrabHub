import { Save, PlayCircle, X } from "lucide-react";
import { t } from "@/lib/i18n";

interface NotebookToolbarProps {
  onSave: () => void;
  onRunAll: () => void;
  isRunningAll: boolean;
  onClose: () => void;
}

const NotebookToolbar: React.FC<NotebookToolbarProps> = ({
  onSave, onRunAll, isRunningAll, onClose
}) => {
  return (
    <div className="flex items-center justify-between bg-muted/30 px-2 py-0.5 border-b border-border min-h-[30px] shrink-0">
      <div className="flex items-center gap-1">
        <button aria-label={t('notebook.close')} onClick={onClose}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title={t('notebook.close')}
        >
          <X size={14} />
        </button>
        <span className="text-xs font-medium text-foreground">{t('notebook.title')}</span>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onRunAll}
          disabled={isRunningAll}
          className="flex items-center gap-1 bg-[hsl(var(--tab-active))] hover:opacity-90 text-white px-2 py-0.5 rounded text-xs transition-colors disabled:opacity-50"
        >
          {isRunningAll ? (
            <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <PlayCircle size={14} />
          )}
          <span>{t('notebook.runAll')}</span>
        </button>
        <button
          onClick={onSave}
          className="flex items-center gap-1 hover:bg-muted text-muted-foreground hover:text-foreground px-2 py-0.5 rounded text-xs border border-border transition-colors"
        >
          <Save size={14} />
          <span>{t('notebook.save')}</span>
        </button>
      </div>
    </div>
  );
};

export default NotebookToolbar;
