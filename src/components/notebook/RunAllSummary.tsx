import React from "react";
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
    <div className={`mb-6 p-4 rounded border ${summary.success ? "bg-success/20 border-success" : "bg-destructive/20 border-destructive"}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-2">
          {summary.success ? (
            <CheckCircle className="w-5 h-5 text-success" />
          ) : (
            <XCircle className="w-5 h-5 text-destructive" />
          )}
          <h3 className={`text-sm font-medium ${summary.success ? "text-success" : "text-destructive"}`}>
            {summary.success ? "All cells executed successfully" : "Some cells failed to execute"}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="text-sm text-foreground mb-2">
        <span>Executed: {summary.executed} | Failed: {summary.failed}</span>
      </div>
      {!summary.success && summary.errors.length > 0 && (
        <div className="mt-2">
          <h4 className="text-sm font-medium text-destructive mb-2">Errors:</h4>
          <ul className="text-xs text-destructive space-y-1">
            {summary.errors.map((error, index) => (
              <li key={index} className="bg-destructive/20 p-2 rounded">
                {error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default RunAllSummary;