import { t } from '@/lib/i18n'

export default function TableDataError({ error }: { error: string }) {
  const schemaAccessDenied = /permission denied for schema\b/i.test(error)

  return (
    <div role="alert" className="flex min-h-full items-center justify-center p-4 text-sm">
      <div className="flex w-full min-w-0 max-w-xl flex-col items-center gap-2 text-center">
        <h3 className="font-medium text-destructive">
          {t(schemaAccessDenied ? 'data.schemaAccessDenied' : 'common.error')}
        </h3>
        {schemaAccessDenied && (
          <p className="text-muted-foreground">{t('data.schemaAccessRequired')}</p>
        )}
        <p className="w-full break-words text-xs text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      </div>
    </div>
  )
}
