import { ConfirmDialog } from '@/components/ConfirmDialog'
import WelcomeScreen from '@/components/WelcomeScreen'
import { EditorContextMenu } from '@/features/editor/EditorContextMenu'
import { cancelExecution } from '@/features/editor/execution-client'
import QuickChartPanel from '@/features/editor/QuickChartPanel'
import { useTransactionStore } from '@/features/editor/transaction-store'
import { buildWhereClause, buildWhereConditions } from '@/lib/export'
import { t } from '@/lib/i18n'
import { cancelQuery, deleteTableRows, updateTableRows } from '@/lib/tauri-commands'
import { useUIStore } from '@/stores/app-store'
import { isDarkTheme } from '@/stores/modules/ui'
import Editor from '@monaco-editor/react'
import {
  AlignLeft,
  Brain,
  CheckCircle2,
  Code2,
  Database,
  Lightbulb,
  Loader2,
  Play,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ResultTable } from './ResultTable'
import { useQueryEditor } from './useQueryEditor'
export function QueryEditor() {
  const {
    activeTabId,
    isExecuting,
    setQueryResult,
    theme,
    toggleSnippetPanel,
    editorRef,
    resultTab,
    setResultTab,
    messages,
    setMessages,
    executionTime,
    importPreview,
    setImportPreview,
    importTableName,
    setImportTableName,
    contextMenu,
    setContextMenu,
    multiResults,
    activeResultIdx,
    setActiveResultIdx,
    executionMode,
    setExecutionMode,
    readConcurrency,
    setReadConcurrency,
    scriptSupported,
    atomicScript,
    setAtomicScript,
    stopOnError,
    setStopOnError,
    executionRef,
    chartPanel,
    setChartPanel,
    isLoadingMore,
    loadMoreState,
    confirmDialog,
    setConfirmDialog,
    activeTab,
    result,
    connectedConnections,
    transactionPending,
    effectiveConnectionId,
    activeConnection,
    isTxActive,
    handleConnectionChange,
    selectedDatabase,
    databaseList,
    handleDatabaseChange,
    handleEditorMount,
    handleEditorChange,
    handleExecute,
    handleLoadMore,
    hasSelection,
    handleCut,
    handleCopy,
    handlePaste,
    handleSelectAll,
    handleSelectCurrentStatement,
    handleFormat,
    handleConvertDialect,
    handleGenerateChart,
    handleExport,
    handleConfirmImport,
    handleTransaction,
  } = useQueryEditor()
  if (!activeTab) {
    return <WelcomeScreen />
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full">
      {/* Controls row */}
      <div className="flex flex-wrap items-center min-h-8 gap-y-1 border-b border-border shrink-0 bg-muted/20">
        <div className="flex items-center gap-2 px-2">
          {/* Connection selector */}
          <select
            value={effectiveConnectionId || ''}
            onChange={e => handleConnectionChange(e.target.value)}
            disabled={isTxActive || transactionPending}
            className="text-xs px-1.5 py-0.5 rounded border border-border bg-background text-foreground max-w-[180px] truncate focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
            title={t('sidebar.connections')}
          >
            <option value="" disabled>
              {t('sidebar.connections')}
            </option>
            {connectedConnections.map(conn => (
              <option key={conn.id} value={conn.id}>
                {conn.name}
              </option>
            ))}
          </select>
          {/* Database selector */}
          {databaseList.length > 1 && (
            <select
              value={selectedDatabase}
              onChange={e => handleDatabaseChange(e.target.value)}
              className="text-xs px-1.5 py-0.5 rounded border border-border bg-background text-foreground max-w-[150px] truncate focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
              title="Database"
            >
              <option value="" disabled>
                Database
              </option>
              {databaseList.map(db => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </select>
          )}
          {isTxActive && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-warning/20 text-warning animate-pulse">
              {t('common.transactionActive')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 ml-auto min-w-0">
          {scriptSupported && (
            <>
              <select
                data-testid="execution-mode"
                aria-label={t('editor.executionMode')}
                value={executionMode}
                disabled={!!isExecuting[activeTabId!] || isTxActive}
                onChange={event =>
                  setExecutionMode(event.target.value as 'legacy' | 'script' | 'independent')
                }
                className="text-xs max-w-40 px-1 py-0.5 border border-border bg-background rounded"
              >
                <option value="legacy">{t('editor.executionLegacy')}</option>
                <option value="script">{t('editor.executionScript')}</option>
                <option value="independent">{t('editor.executionIndependent')}</option>
              </select>
              {executionMode === 'independent' && (
                <input
                  type="number"
                  aria-label={t('editor.readConcurrency')}
                  title={t('editor.readConcurrency')}
                  min={1}
                  max={8}
                  step={1}
                  value={readConcurrency}
                  disabled={!!isExecuting[activeTabId!]}
                  onChange={event =>
                    setReadConcurrency(
                      Math.max(1, Math.min(8, Math.trunc(Number(event.target.value) || 1)))
                    )
                  }
                  className="text-xs w-12 px-1 py-0.5 border border-border bg-background rounded"
                />
              )}
              {executionMode === 'script' && (
                <>
                  <label className="flex items-center gap-1 px-1 text-xs whitespace-nowrap">
                    <input
                      data-testid="script-atomic"
                      type="checkbox"
                      checked={atomicScript}
                      disabled={!!isExecuting[activeTabId!]}
                      onChange={event => setAtomicScript(event.target.checked)}
                    />
                    {t('editor.scriptAtomic')}
                  </label>
                  <label className="flex items-center gap-1 px-1 text-xs whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={atomicScript || stopOnError}
                      disabled={atomicScript || !!isExecuting[activeTabId!]}
                      onChange={event => setStopOnError(event.target.checked)}
                    />
                    {t('editor.scriptStopOnError')}
                  </label>
                </>
              )}
            </>
          )}
          {executionTime !== null && (
            <span className="text-[11px] text-muted-foreground mr-1">
              {executionTime.toFixed(0)} ms
            </span>
          )}
          {/* Transaction buttons */}
          {effectiveConnectionId && scriptSupported && executionMode === 'legacy' && (
            <>
              <button
                onClick={() => handleTransaction('begin')}
                disabled={isTxActive || transactionPending || isExecuting[activeTabId!]}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                title={t('editor.beginTransaction')}
              >
                <Database size={11} />
                {t('editor.beginTransaction')}
              </button>
              <button
                onClick={() => handleTransaction('commit')}
                disabled={!isTxActive || transactionPending || isExecuting[activeTabId!]}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                title={t('editor.commitTransaction')}
              >
                <CheckCircle2 size={11} />
                {t('editor.commit')}
              </button>
              <button
                onClick={() => handleTransaction('rollback')}
                disabled={!isTxActive || transactionPending || isExecuting[activeTabId!]}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors disabled:opacity-40"
                title={t('editor.rollbackTransaction')}
              >
                <RotateCcw size={11} />
                {t('editor.rollback')}
              </button>
            </>
          )}
          <button
            aria-label={t('editor.formatSql')}
            onClick={handleFormat}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
            title={t('editor.formatSql')}
          >
            <AlignLeft size={12} />
            {t('editor.format')}
          </button>
          <button
            aria-label={t('editor.snippet')}
            onClick={toggleSnippetPanel}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
            title={t('editor.snippet')}
          >
            <Code2 size={12} />
            {t('editor.snippetShort')}
          </button>
          <button
            onClick={() => useUIStore.getState().toggleAIPanel()}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
            title="AI Assistant"
          >
            <Brain size={12} />
            AI
          </button>
          <button
            onClick={async () => {
              const sql = editorRef.current?.getValue() || ''
              if (sql) {
                useUIStore.getState().toggleAIPanel()
                // Set AI input to optimize the SQL
                setTimeout(() => {
                  const aiInput = document.querySelector('.ai-input')
                  if (aiInput) {
                    ;(aiInput as HTMLTextAreaElement).value = `帮我优化这个SQL: ${sql}`
                  }
                }, 100)
              }
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-accent rounded transition-colors"
            title={t('ai.optimizeSql')}
          >
            <Lightbulb size={12} />
            {t('ai.optimizeSql')}
          </button>
          {isExecuting[activeTabId!] && (
            <button
              onClick={async () => {
                try {
                  const execution = executionRef.current
                  if (activeTabId && useTransactionStore.getState().sessions[activeTabId])
                    await useTransactionStore.getState().cancel(activeTabId)
                  else if (execution?.script) await cancelExecution(execution.id)
                  else if (effectiveConnectionId) await cancelQuery(effectiveConnectionId)
                  setMessages(prev => [...prev, t('editor.cancelRequested')])
                } catch (error) {
                  setMessages(prev => [...prev, String(error)])
                }
              }}
              className="flex items-center gap-1 px-2.5 py-0.5 text-xs bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 transition-colors"
              title="Cancel query"
            >
              <XCircle size={12} />
              Cancel
            </button>
          )}
          <button
            onClick={() => handleExecute()}
            disabled={!!isExecuting[activeTabId!] || transactionPending || !effectiveConnectionId}
            data-testid="run-sql"
            className="flex items-center gap-1 px-2.5 py-0.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
            title={t('editor.executeQuery')}
          >
            {isExecuting[activeTabId!] ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            {t('common.execute')}
          </button>
        </div>
      </div>

      {/* Resizable Editor + Result panels */}
      <PanelGroup direction="vertical" autoSaveId="query-editor-panels" className="flex-1 min-h-0">
        {/* SQL Editor Panel */}
        <Panel defaultSize={60} minSize={20}>
          <div className="h-full">
            <Editor
              key={activeTab.id}
              height="100%"
              language="sql"
              theme={isDarkTheme(theme) ? 'vs-dark' : 'vs'}
              value={activeTab.content || ''}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              options={{
                cursorStyle: 'line',
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 20,
                padding: { top: 8, bottom: 8 },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                tabSize: 2,
                renderLineHighlight: 'line',
                suggestOnTriggerCharacters: true,
                quickSuggestions: true,
                folding: true,
                lineNumbers: 'on',
                glyphMargin: false,
                contextmenu: false,
                scrollbar: {
                  verticalScrollbarSize: 6,
                  horizontalScrollbarSize: 6,
                },
              }}
            />
          </div>

          {/* Custom Context Menu */}
          {contextMenu && (
            <EditorContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              hasSelection={hasSelection()}
              sourceDialect={activeConnection?.type}
              onClose={() => setContextMenu(null)}
              onRunAll={() => {
                setContextMenu(null)
                handleExecute(false)
              }}
              onRunSelected={() => {
                setContextMenu(null)
                handleExecute(true)
              }}
              onFormat={() => {
                setContextMenu(null)
                handleFormat()
              }}
              onCut={() => {
                setContextMenu(null)
                handleCut()
              }}
              onCopy={() => {
                setContextMenu(null)
                handleCopy()
              }}
              onPaste={() => {
                setContextMenu(null)
                handlePaste()
              }}
              onSelectAll={() => {
                setContextMenu(null)
                handleSelectAll()
              }}
              onSelectCurrentStatement={() => {
                setContextMenu(null)
                handleSelectCurrentStatement()
              }}
              onConvertDialect={target => {
                setContextMenu(null)
                handleConvertDialect(target)
              }}
            />
          )}
        </Panel>

        {/* Resize Handle */}
        <PanelResizeHandle className="h-px bg-border hover:bg-[hsl(var(--tab-active))] transition-colors cursor-row-resize opacity-0 hover:opacity-100" />

        {/* Result Panel */}
        <Panel defaultSize={40} minSize={10}>
          <div className="flex flex-col h-full min-w-0">
            {/* Result Tab Bar */}
            <div
              data-testid="result-toolbar"
              className="flex min-w-0 items-center gap-2 px-2 py-0.5 border-b border-border shrink-0 bg-muted/20"
            >
              <div
                data-testid="result-tabs"
                className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap [&>button]:shrink-0"
              >
                {/* Multi-result tabs when multiple SELECT results exist */}
                {multiResults.length > 1 ? (
                  <>
                    {multiResults.map((r, idx) => (
                      <button
                        key={`result-${idx}`}
                        onClick={() => {
                          setActiveResultIdx(idx)
                          if (activeTabId) setQueryResult(activeTabId, r)
                          setResultTab('results')
                        }}
                        className={`px-2.5 py-1 text-xs transition-colors ${
                          resultTab === 'results' && activeResultIdx === idx
                            ? 'text-foreground border-b-2 border-[hsl(var(--tab-active))]'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {`${t('editor.resultCount', { suffix: '' })} ${idx + 1} (${r.rowCount}${loadMoreState[idx]?.hasMore ? '+' : ''})`}
                      </button>
                    ))}
                    <button
                      onClick={() => setResultTab('messages')}
                      className={`px-2.5 py-1 text-xs transition-colors ${
                        resultTab === 'messages'
                          ? 'text-foreground border-b-2 border-[hsl(var(--tab-active))]'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t('editor.messages')}
                    </button>
                  </>
                ) : (
                  <>
                    {multiResults.length === 1 && (
                      <button
                        onClick={() => setResultTab('results')}
                        className={`px-2.5 py-1 text-xs transition-colors ${
                          resultTab === 'results'
                            ? 'text-foreground border-b-2 border-[hsl(var(--tab-active))]'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {t('editor.resultCount', {
                          suffix: ` (${multiResults[0]!.rowCount}${loadMoreState[0]?.hasMore ? '+' : ''})`,
                        })}
                      </button>
                    )}
                    <button
                      onClick={() => setResultTab('messages')}
                      className={`px-2.5 py-1 text-xs transition-colors ${
                        resultTab === 'messages'
                          ? 'text-foreground border-b-2 border-[hsl(var(--tab-active))]'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t('editor.messages')}
                      {messages.length > 0 && ` (${messages.length})`}
                    </button>
                  </>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Export buttons */}
                {resultTab === 'results' && result && result.columns.length > 0 && (
                  <>
                    <button
                      onClick={() => handleExport('csv')}
                      className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                    >
                      CSV
                    </button>
                    <button
                      onClick={() => handleExport('json')}
                      className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                    >
                      JSON
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Import preview bar */}
            {importPreview && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0 bg-muted/30">
                <span className="text-[11px] text-muted-foreground">
                  {t('editor.importTargetTable')}
                </span>
                <input
                  type="text"
                  value={importTableName}
                  onChange={e => setImportTableName(e.target.value)}
                  className="px-2 py-0.5 text-xs bg-background border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground w-40"
                />
                <button
                  onClick={handleConfirmImport}
                  disabled={
                    isTxActive ||
                    transactionPending ||
                    isExecuting[activeTabId!] ||
                    !importTableName.trim()
                  }
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40"
                >
                  <CheckCircle2 size={10} />
                  {t('editor.confirmImport')}
                </button>
                <button
                  onClick={() => setImportPreview(null)}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                >
                  <XCircle size={10} />
                  {t('common.cancel')}
                </button>
              </div>
            )}

            {/* Result Content */}
            <div className="flex-1 min-h-0">
              {resultTab === 'results' && (
                <ResultTable
                  result={result}
                  importPreview={importPreview}
                  hasMore={loadMoreState[activeResultIdx]?.hasMore ?? false}
                  isLoadingMore={isLoadingMore}
                  onLoadMore={() => handleLoadMore(activeResultIdx)}
                  onApplyChanges={
                    isTxActive
                      ? undefined
                      : async (modifiedCells, columns, rows) => {
                          if (activeTabId && useTransactionStore.getState().sessions[activeTabId])
                            return
                          if (!activeTab?.tableName || !effectiveConnectionId) return
                          const rowGroups = new Map<number, [string, any][]>()
                          for (const [key, value] of modifiedCells.entries()) {
                            const parts = key.split(':')
                            const rowIdxStr = parts[0]
                            const colName = parts[1]
                            if (!rowIdxStr || !colName) continue
                            const idx = parseInt(rowIdxStr)
                            if (!rowGroups.has(idx)) rowGroups.set(idx, [])
                            rowGroups.get(idx)!.push([colName, value])
                          }
                          for (const [rowIdx, updates] of rowGroups.entries()) {
                            const row = rows[rowIdx]
                            if (!row) continue
                            const whereConditions = buildWhereConditions(columns, row)
                            await updateTableRows(
                              effectiveConnectionId,
                              activeTab.tableName,
                              updates,
                              whereConditions,
                              activeTab.schemaName
                            )
                          }
                          handleExecute()
                        }
                  }
                  onDeleteRows={
                    isTxActive
                      ? undefined
                      : async rowIndices => {
                          if (!activeTab?.tableName || !effectiveConnectionId) return
                          const tableName = activeTab.tableName
                          const schemaName = activeTab.schemaName
                          setConfirmDialog({
                            message: t('table.deleteConfirm', { count: String(rowIndices.length) }),
                            onConfirm: async () => {
                              setConfirmDialog(null)
                              if (
                                activeTabId &&
                                useTransactionStore.getState().sessions[activeTabId]
                              )
                                return
                              for (const idx of rowIndices) {
                                const row = result?.rows[idx]
                                if (!row) continue
                                const whereConditions = buildWhereConditions(result!.columns, row)
                                await deleteTableRows(
                                  effectiveConnectionId,
                                  tableName,
                                  whereConditions,
                                  schemaName
                                )
                              }
                              handleExecute()
                            },
                          })
                        }
                  }
                  onGenerateDeleteSQL={rowIndices => {
                    const statements = rowIndices
                      .map(idx => {
                        const row = result?.rows[idx]
                        if (!row) return ''
                        const whereClause = buildWhereClause(result!.columns, row)
                        const schemaPrefix = activeTab?.schemaName
                          ? `"${activeTab.schemaName}".`
                          : ''
                        return `DELETE FROM ${schemaPrefix}"${activeTab?.tableName || 'table'}" WHERE ${whereClause};`
                      })
                      .filter(Boolean)
                      .join('\n')
                    if (!statements) return
                    const editor = editorRef.current
                    if (editor) {
                      const selection = editor.getSelection()
                      editor.executeEdits('delete-sql', [
                        {
                          range: selection || {
                            startLineNumber: 1,
                            startColumn: 1,
                            endLineNumber: 1,
                            endColumn: 1,
                          },
                          text: statements + '\n',
                        },
                      ])
                    }
                  }}
                  onGenerateChart={handleGenerateChart}
                />
              )}
              {resultTab === 'messages' && (
                <div className="p-3 space-y-2 overflow-auto">
                  {/* Summary */}
                  {executionTime !== null && (
                    <div className="text-xs text-muted-foreground space-y-1 mb-3 pb-3 border-b border-border">
                      <p>{t('editor.totalTime', { ms: executionTime.toFixed(0) })}</p>
                      {multiResults.length > 0 && (
                        <p>
                          {t('editor.resultCount', {
                            suffix: `: ${multiResults.map(r => r.rowCount).join(', ')}`,
                          })}
                        </p>
                      )}
                    </div>
                  )}
                  {messages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('editor.noMessages')}</p>
                  ) : (
                    messages.map((msg, i) => (
                      <p
                        key={i}
                        className={`text-xs ${
                          msg.startsWith(t('common.error')) ||
                          msg.startsWith(t('editor.importFailedShort')) ||
                          msg.startsWith(t('editor.transactionFailed'))
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {msg}
                      </p>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {chartPanel && (
        <QuickChartPanel
          columns={chartPanel.columns}
          rows={chartPanel.rows}
          onClose={() => setChartPanel(null)}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          open
          message={confirmDialog.message}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  )
}
