import WelcomeScreen from '@/components/WelcomeScreen'
import NotebookView from '@/features/editor/notebook/NotebookView'
import VisualQueryBuilder from '@/features/editor/query-builder/VisualQueryBuilder'
import ERDiagram from '@/features/schema/ERDiagram'
import TableDesigner from '@/features/schema/TableDesigner'
import { t } from '@/lib/i18n'
import { useTabStore, useUIStore } from '@/stores/app-store'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { QueryEditor } from './QueryEditor'

loader.config({ monaco })

function EditorPanel() {
  useUIStore(state => state.language)
  const { tabs, activeTabId, addTab, closeTab } = useTabStore(
    useShallow(state => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      addTab: state.addTab,
      closeTab: state.closeTab,
    }))
  )
  const activeTab = tabs.find(t => t.id === activeTabId)

  if (!activeTab) {
    return <WelcomeScreen />
  }

  // Heavy tab types: keep mounted, CSS visibility toggle (preserves state + scroll)
  const HEAVY_TYPES = ['er', 'designer', 'notebook', 'query-builder']
  const heavyTabs = tabs.filter(t => HEAVY_TYPES.includes(t.type))

  // Query / diff / migration: render conditionally as before
  if (activeTab.type === 'query' || activeTab.type === 'diff' || activeTab.type === 'migration') {
    if (activeTab.type === 'diff') {
      return (
        <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
          {t('layout.schemaDiffHint')}
        </div>
      )
    }
    return <QueryEditor />
  }

  return (
    <>
      {heavyTabs.map(tab => (
        <div
          key={tab.id}
          className="h-full overflow-auto"
          style={{ display: tab.id === activeTabId ? undefined : 'none' }}
        >
          <HeavyTabContent tab={tab} tabs={tabs} addTab={addTab} closeTab={closeTab} />
        </div>
      ))}
    </>
  )
}

function HeavyTabContent({
  tab,
  tabs,
  addTab,
  closeTab,
}: {
  tab: ReturnType<typeof useTabStore.getState>['tabs'][number]
  tabs: ReturnType<typeof useTabStore.getState>['tabs']
  addTab: ReturnType<typeof useTabStore.getState>['addTab']
  closeTab: ReturnType<typeof useTabStore.getState>['closeTab']
}) {
  switch (tab.type) {
    case 'er':
      return (
        <ERDiagram
          embedded={true}
          connectionId={tab.connectionId || ''}
          schemaName={tab.schemaName}
        />
      )
    case 'designer': {
      const editTable = tab.tableName ? { name: tab.tableName, schema: tab.schemaName } : undefined
      return <TableDesigner connectionId={tab.connectionId || ''} editTable={editTable} />
    }
    case 'notebook':
      return <NotebookView connectionId={tab.connectionId || ''} onClose={() => closeTab(tab.id)} />
    case 'query-builder':
      return (
        <VisualQueryBuilder
          connectionId={tab.connectionId || ''}
          onClose={() => closeTab(tab.id)}
          onQueryGenerated={sql => {
            const queryCount = tabs.filter(t => t.type === 'query').length + 1
            const newTabId = addTab({
              title: `${t('tab.query')} ${queryCount}`,
              type: 'query',
              content: sql,
              connectionId: tab.connectionId,
            })
            useTabStore.getState().setActiveTab(newTabId)
          }}
        />
      )
    default:
      return null
  }
}
export default memo(EditorPanel)
