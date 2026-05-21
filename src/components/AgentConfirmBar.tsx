import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

interface AgentConfirmBarProps {
  sql: string;
  reason: string;
  onApprove: () => void;
  onReject: () => void;
}

export function AgentConfirmBar({ sql, reason, onApprove, onReject }: AgentConfirmBarProps) {
  return (
    <div className="border border-warning/30 rounded-lg p-3 bg-warning/10 my-2">
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert size={16} className="text-warning" />
        <span className="text-sm font-medium text-warning">
          {t('agent.confirmTitle')}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-2">{reason}</p>
      <pre className="text-xs font-mono bg-muted p-2 rounded mb-2 overflow-x-auto whitespace-pre-wrap">
        {sql}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={onApprove}>{t('agent.execute')}</Button>
        <Button size="sm" variant="outline" onClick={onReject}>{t('agent.ignore')}</Button>
      </div>
    </div>
  );
}
