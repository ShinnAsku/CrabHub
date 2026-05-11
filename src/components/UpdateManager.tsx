import React, { useState, useEffect } from "react";
import { t } from "@/lib/i18n";
import { CheckCircle, Clock, Download, RefreshCw, X } from "lucide-react";
import { checkForUpdates, installUpdate, UpdateStatus } from "@/lib/tauri-commands";

interface UpdateManagerProps {
  onClose: () => void;
}

const UpdateManager: React.FC<UpdateManagerProps> = ({ onClose }) => {
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCheckForUpdates = async () => {
    try {
      setChecking(true);
      setError(null);
      const status = await checkForUpdates();
      setUpdateStatus(status);
    } catch (err) {
      setError(`Failed to check for updates: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    } finally {
      setChecking(false);
    }
  };

  const handleInstallUpdate = async () => {
    try {
      setInstalling(true);
      setError(null);
      await installUpdate();
      // The app will restart after installation
    } catch (err) {
      setError(`Failed to install update: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    } finally {
      setInstalling(false);
    }
  };

  // Check for updates on mount
  useEffect(() => {
    handleCheckForUpdates();
  }, []);

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between bg-muted px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-medium text-foreground">{t('update.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCheckForUpdates}
            className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title="Check for updates"
            disabled={checking}
          >
            <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive rounded-md">
            <div className="flex items-center">
              <X className="w-4 h-4 text-destructive mr-2" />
              <span className="text-destructive">{error}</span>
            </div>
          </div>
        )}

        <div className="mb-6">
          <h2 className="text-md font-medium text-foreground mb-2">{t('update.checkStatus')}</h2>
          <p className="text-sm text-muted-foreground mb-4">{t('update.checkDescription')}</p>

          {checking && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <RefreshCw size={16} className="animate-spin" />
              {t('update.checking')}
            </div>
          )}

          {!checking && updateStatus && (
            <div className="flex flex-col gap-4">
              {updateStatus.available ? (
                <div className="bg-accent/10 border border-accent rounded-md p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-1">
                      <Download className="w-5 h-5 text-accent" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-md font-medium text-foreground mb-1">
                        {t('update.updateAvailable')}
                      </h3>
                      <p className="text-sm text-muted-foreground mb-2">
                        {t('update.newVersion', { version: updateStatus.version })}
                      </p>
                      <div className="text-xs text-muted-foreground mb-3">
                        <div className="flex items-center gap-1 mb-1">
                          <Clock size={12} />
                          <span>{updateStatus.date}</span>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground bg-muted p-3 rounded">
                        <h4 className="font-medium mb-1">{t('update.releaseNotes')}:</h4>
                        <pre className="whitespace-pre-wrap">{updateStatus.body}</pre>
                      </div>
                      <div className="mt-4">
                        <button
                          onClick={handleInstallUpdate}
                          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded transition-colors hover:bg-primary/90"
                          disabled={installing}
                        >
                          {installing ? (
                            <>
                              <RefreshCw size={16} className="animate-spin" />
                              <span>{t('update.installing')}</span>
                            </>
                          ) : (
                            <>
                              <Download size={16} />
                              <span>{t('update.install')}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-muted border border-border rounded-md p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-1">
                      <CheckCircle className="w-5 h-5 text-success" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-md font-medium text-foreground mb-1">
                        {t('update.noUpdate')}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {t('update.latestVersion')}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UpdateManager;