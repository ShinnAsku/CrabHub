import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench, Check, X, Loader2 } from "lucide-react";

interface AgentToolCardProps {
  toolName: string;
  status: "running" | "success" | "error" | "denied";
  resultSummary?: string;
  resultDetail?: unknown;
}

export function AgentToolCard({ toolName, status, resultSummary, resultDetail }: AgentToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    running: <Loader2 size={14} className="animate-spin text-blue-500" />,
    success: <Check size={14} className="text-green-500" />,
    error: <X size={14} className="text-red-500" />,
    denied: <X size={14} className="text-orange-500" />,
  }[status];

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-xs
          bg-muted/30 hover:bg-muted/50 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} />
        <span className="font-mono font-medium">{toolName}</span>
        {resultSummary && (
          <span className="text-muted-foreground truncate ml-2">{resultSummary}</span>
        )}
        <span className="ml-auto">{statusIcon}</span>
      </button>
      {expanded && resultDetail != null && (
        <div className="px-3 py-2 text-xs font-mono bg-muted/20 max-h-32 overflow-auto">
          <pre className="whitespace-pre-wrap text-muted-foreground">
            {typeof resultDetail === "string"
              ? (resultDetail as string)
              : (JSON.stringify(resultDetail, null, 2) as string)}
          </pre>
        </div>
      )}
    </div>
  );
}
