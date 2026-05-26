import { CheckCircle, XCircle, X } from "lucide-react";

interface RunSummary {
  success: boolean;
  executed: number;
  failed: number;
  errors: string[];
}

interface RunAllSummaryProps {
  summary: RunSummary;
  onClose: () => void;
}

const RunAllSummary: React.FC<RunAllSummaryProps> = ({ summary, onClose }) => {
  return (
    <div className={`mb-2 p-2 rounded border text-xs ${
      summary.success ? "bg-green-500/10 border-green-500/30" : "bg-destructive/10 border-destructive/30"
    }`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          {summary.success ? (
            <CheckCircle size={14} className="text-green-500" />
          ) : (
            <XCircle size={14} className="text-destructive" />
          )}
          <span className={`font-medium ${summary.success ? "text-green-600" : "text-destructive"}`}>
            {summary.success ? "All cells executed" : "Some cells failed"}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <X size={12} />
        </button>
      </div>
      <span className="text-muted-foreground">
        Executed: {summary.executed} | Failed: {summary.failed}
      </span>
      {!summary.success && summary.errors.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {summary.errors.map((error, index) => (
            <li key={index} className="bg-destructive/10 p-1 rounded text-destructive">
              {error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default RunAllSummary;
