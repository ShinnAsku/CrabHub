import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Boxes,
  Container,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Terminal,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { t } from '@/lib/i18n'
import {
  dockerArgument,
  dockerExecute,
  dockerLoad,
  dockerPlan,
  dockerSnapshot,
  loadDockerProfiles,
  LOCAL_DOCKER,
  type DockerOutput,
  type DockerProfile,
} from '@/features/docker/client'
import { ConfirmDialog } from '@/components/ConfirmDialog'

function Tool({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
    >
      <Icon size={15} />
    </button>
  )
}

function ProfileForm({
  profile,
  onSave,
  onClose,
}: {
  profile: DockerProfile
  onSave: (profile: DockerProfile) => void
  onClose: () => void
}) {
  const [name, setName] = useState(profile.name)
  const [kind, setKind] = useState(profile.connection.kind)
  const [endpoint, setEndpoint] = useState(profile.connection.endpoint)
  const initial = profile.connection.kind === 'ssh' ? profile.connection : null
  const [host, setHost] = useState(initial?.host || '')
  const [user, setUser] = useState(initial?.user || '')
  const [port, setPort] = useState(initial?.port || 22)
  const [identityFile, setIdentityFile] = useState(initial?.identityFile || '')
  const [knownHostsFile, setKnownHostsFile] = useState(initial?.knownHostsFile || '')
  const inputClass =
    'mt-1 h-8 w-full min-w-0 rounded border border-border bg-background px-2 text-sm'
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    onSave({
      id: profile.id,
      name: name.trim(),
      connection:
        kind === 'local'
          ? { kind, endpoint: endpoint.trim() }
          : {
              kind,
              host: host.trim(),
              user: user.trim(),
              port,
              endpoint: endpoint.trim(),
              identityFile: identityFile.trim(),
              knownHostsFile: knownHostsFile.trim(),
            },
    })
  }
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-3">
      <form
        role="dialog"
        aria-label={t('docker.connection')}
        onSubmit={submit}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('docker.connection')}</h2>
          <Tool icon={X} label={t('common.close')} onClick={onClose} />
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <label className="col-span-2">
            {t('docker.name')}
            <input
              autoFocus
              required
              aria-label={t('docker.name')}
              className={inputClass}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className="col-span-2">
            {t('docker.transport')}
            <select
              aria-label={t('docker.transport')}
              className={inputClass}
              value={kind}
              onChange={event => {
                setKind(event.target.value as 'local' | 'ssh')
                setEndpoint('')
              }}
            >
              <option value="local">{t('docker.local')}</option>
              <option value="ssh">SSH</option>
            </select>
          </label>
          {kind === 'ssh' && (
            <>
              <label className="col-span-2">
                {t('docker.host')}
                <input
                  required
                  aria-label={t('docker.host')}
                  className={inputClass}
                  value={host}
                  onChange={event => setHost(event.target.value)}
                />
              </label>
              <label>
                {t('docker.user')}
                <input
                  required
                  aria-label={t('docker.user')}
                  className={inputClass}
                  value={user}
                  onChange={event => setUser(event.target.value)}
                />
              </label>
              <label>
                {t('docker.port')}
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  aria-label={t('docker.port')}
                  className={inputClass}
                  value={port}
                  onChange={event => setPort(Number(event.target.value))}
                />
              </label>
              <label className="col-span-2">
                {t('docker.identity')}
                <input
                  aria-label={t('docker.identity')}
                  className={inputClass}
                  value={identityFile}
                  onChange={event => setIdentityFile(event.target.value)}
                />
              </label>
              <label className="col-span-2">
                known_hosts
                <input
                  aria-label="known_hosts"
                  className={inputClass}
                  value={knownHostsFile}
                  onChange={event => setKnownHostsFile(event.target.value)}
                />
              </label>
            </>
          )}
          <label className="col-span-2">
            {t('docker.endpoint')}
            <input
              aria-label={t('docker.endpoint')}
              className={inputClass}
              placeholder={
                kind === 'ssh' ? 'unix:///var/run/docker.sock' : t('docker.defaultEndpoint')
              }
              value={endpoint}
              onChange={event => setEndpoint(event.target.value)}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm hover:bg-muted"
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function DockerManager({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState(loadDockerProfiles)
  const [activeId, setActiveId] = useState(() => profiles[0]!.id)
  const profile = profiles.find(item => item.id === activeId) || profiles[0]!
  const [editing, setEditing] = useState<DockerProfile | null>(null)
  const [view, setView] = useState<'containers' | 'images' | 'commands'>('containers')
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof dockerSnapshot>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [command, setCommand] = useState('docker ps -a')
  const [output, setOutput] = useState<{ command: string; result: DockerOutput } | null>(null)
  const [pending, setPending] = useState<{ command: string; profile: DockerProfile } | null>(null)
  const [removeProfile, setRemoveProfile] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [archivePath, setArchivePath] = useState('')
  const generation = useRef(0)

  async function refresh(connection = profile.connection) {
    const request = ++generation.current
    setBusy(true)
    setError('')
    try {
      const next = await dockerSnapshot(connection)
      if (generation.current === request) setSnapshot(next)
    } catch (failure) {
      if (generation.current === request) {
        setSnapshot(null)
        setError(String(failure))
      }
    } finally {
      if (generation.current === request) setBusy(false)
    }
  }

  useEffect(() => {
    setSnapshot(null)
    setOutput(null)
    setSearch('')
    void refresh(profile.connection)
    return () => {
      generation.current++
    }
  }, [profile])

  async function execute(text: string, target: DockerProfile, confirmed: boolean) {
    const request = ++generation.current
    setBusy(true)
    setError('')
    setPending(null)
    try {
      const result = await dockerExecute(target.connection, text, confirmed)
      if (generation.current !== request) return
      setOutput({ command: text, result })
      if (result.exitCode !== 0) setError(result.stderr || `Docker exit ${result.exitCode}`)
      if (confirmed) {
        const next = await dockerSnapshot(target.connection)
        if (generation.current === request) setSnapshot(next)
      }
    } catch (failure) {
      if (generation.current === request) {
        setError(String(failure))
        if (confirmed) setSnapshot(null)
      }
    } finally {
      if (generation.current === request) setBusy(false)
    }
  }

  async function requestCommand(text: string) {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const plan = await dockerPlan(text)
      if (plan.confirmationRequired) {
        setPending({ command: text, profile })
        setBusy(false)
      } else await execute(text, profile, false)
    } catch (failure) {
      setError(String(failure))
      setBusy(false)
    }
  }

  function persist(next: DockerProfile[], nextId: string) {
    try {
      localStorage.setItem('crabhub-docker-profiles', JSON.stringify(next))
    } catch (failure) {
      setError(String(failure))
      return
    }
    setProfiles(next)
    setActiveId(nextId)
    setEditing(null)
    setRemoveProfile(false)
  }

  async function browseArchive() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: 'Docker image archive', extensions: ['tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'] },
        ],
      })
      if (typeof selected === 'string') {
        setArchivePath(selected)
        setError('')
      }
    } catch (failure) {
      setError(String(failure))
    }
  }

  async function importArchive(event: FormEvent) {
    event.preventDefault()
    if (busy || !archivePath.trim()) return
    const request = ++generation.current
    setBusy(true)
    setError('')
    try {
      const result = await dockerLoad(profile.connection, archivePath.trim())
      if (generation.current !== request) return
      setOutput({ command: `docker load < ${archivePath}`, result })
      if (result.exitCode !== 0)
        setError(result.stderr || result.stdout || `Docker exit ${result.exitCode}`)
      else {
        setImportOpen(false)
        setView('images')
        setSearch('')
      }
      const next = await dockerSnapshot(profile.connection)
      if (generation.current === request) setSnapshot(next)
    } catch (failure) {
      if (generation.current === request) setError(String(failure))
    } finally {
      if (generation.current === request) setBusy(false)
    }
  }

  const rows =
    (view === 'containers' ? snapshot?.containers : snapshot?.images)?.filter(row =>
      Object.values(row).join(' ').toLowerCase().includes(search.toLowerCase())
    ) || []
  return (
    <section
      data-testid="docker-manager"
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Container size={18} className="text-primary" />
        <h1 className="mr-2 text-base font-semibold">Docker</h1>
        <select
          aria-label={t('docker.connection')}
          className="h-8 w-52 max-w-full min-w-0 rounded border border-border bg-background px-2 text-sm"
          value={profile.id}
          disabled={busy || !!pending}
          onChange={event => setActiveId(event.target.value)}
        >
          {profiles.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <div className="flex items-center">
          <Tool
            icon={Plus}
            label={t('docker.addConnection')}
            disabled={busy}
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                name: '',
                connection: { kind: 'local', endpoint: '' },
              })
            }
          />
          <Tool
            icon={Pencil}
            label={t('docker.editConnection')}
            disabled={busy}
            onClick={() => setEditing(profile)}
          />
          <Tool
            icon={Trash2}
            label={t('docker.removeConnection')}
            disabled={busy}
            onClick={() => setRemoveProfile(true)}
          />
          <Tool
            icon={busy ? Loader2 : RefreshCw}
            label={t('docker.refresh')}
            disabled={busy}
            onClick={() => void refresh()}
          />
        </div>
        <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
          {snapshot
            ? `Engine ${snapshot.version}`
            : busy
              ? t('common.loading')
              : t('docker.disconnected')}
          {profile.connection.kind === 'ssh'
            ? ` / ${profile.connection.user}@${profile.connection.host}:${profile.connection.port}`
            : ''}
        </span>
        <Tool icon={X} label={t('docker.back')} onClick={onClose} />
      </header>
      <div
        role="tablist"
        aria-label="Docker"
        className="flex shrink-0 items-center gap-1 border-b border-border px-2"
      >
        {(
          [
            { id: 'containers', icon: Container },
            { id: 'images', icon: Boxes },
            { id: 'commands', icon: Terminal },
          ] as const
        ).map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${view === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}
          >
            <Icon size={14} />
            {t(`docker.${id}`)}
          </button>
        ))}
      </div>
      {view === 'images' && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setImportOpen(true)
              setError('')
            }}
            className="flex items-center gap-2 rounded border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
          >
            <Upload size={14} />
            {t('docker.importArchive')}
          </button>
        </div>
      )}
      {error && !importOpen && (
        <div
          role="alert"
          className="max-h-28 shrink-0 overflow-y-auto break-words border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </div>
      )}
      {view === 'commands' ? (
        <form
          className="flex shrink-0 gap-2 border-b border-border p-3"
          onSubmit={event => {
            event.preventDefault()
            void requestCommand(command)
          }}
        >
          <input
            aria-label={t('docker.command')}
            maxLength={8192}
            value={command}
            disabled={busy}
            onChange={event => setCommand(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-sm"
          />
          <button
            type="submit"
            title={t('common.execute')}
            aria-label={t('common.execute')}
            disabled={busy || !command.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground disabled:opacity-40"
          >
            <Play size={16} />
          </button>
        </form>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              aria-label={t('docker.search')}
              className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder={t('common.search')}
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <span className="text-xs tabular-nums text-muted-foreground">{rows.length}</span>
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 overflow-auto border-y border-border">
            <table className="w-full min-w-[760px] table-fixed text-left text-xs">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  <th className="w-[24%] px-3 py-2">{t('docker.name')}</th>
                  <th className="w-[27%] px-3 py-2">
                    {view === 'containers' ? t('docker.image') : 'Tag'}
                  </th>
                  <th className="w-[25%] px-3 py-2">
                    {view === 'containers' ? t('docker.status') : t('docker.size')}
                  </th>
                  <th className="w-52 px-3 py-2">{t('docker.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={`${row.ID}-${index}`}
                    data-testid="docker-resource"
                    className="border-b border-border hover:bg-muted/40"
                  >
                    <td className="break-all px-3 py-2">
                      <div className="font-medium">
                        {view === 'containers' ? row.Names : row.Repository}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                        {row.ID?.replace('sha256:', '').slice(0, 12)}
                      </div>
                    </td>
                    <td className="break-all px-3 py-2">
                      {view === 'containers' ? row.Image : row.Tag}
                    </td>
                    <td className="break-all px-3 py-2">
                      {view === 'containers' ? (
                        <>
                          <span
                            className={
                              row.State === 'running' ? 'text-success' : 'text-muted-foreground'
                            }
                          >
                            {row.Status}
                          </span>
                          <div className="mt-1 text-[10px] text-muted-foreground">{row.Ports}</div>
                        </>
                      ) : (
                        row.Size
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center">
                        {view === 'containers' && (
                          <>
                            <Tool
                              icon={Play}
                              label={t('docker.start')}
                              disabled={busy || row.State === 'running' || row.State === 'paused'}
                              onClick={() =>
                                void requestCommand(`start ${dockerArgument(row.ID!)}`)
                              }
                            />
                            <Tool
                              icon={Square}
                              label={t('docker.stop')}
                              disabled={busy || row.State !== 'running'}
                              onClick={() => void requestCommand(`stop ${dockerArgument(row.ID!)}`)}
                            />
                            <Tool
                              icon={RotateCw}
                              label={t('docker.restart')}
                              disabled={busy}
                              onClick={() =>
                                void requestCommand(`restart ${dockerArgument(row.ID!)}`)
                              }
                            />
                            <Tool
                              icon={FileText}
                              label={t('docker.logs')}
                              disabled={busy}
                              onClick={() =>
                                void requestCommand(
                                  `logs --tail 200 --timestamps ${dockerArgument(row.ID!)}`
                                )
                              }
                            />
                          </>
                        )}
                        <Tool
                          icon={Info}
                          label={t('docker.inspect')}
                          disabled={busy}
                          onClick={() =>
                            void requestCommand(
                              `${view === 'containers' ? 'container' : 'image'} inspect ${dockerArgument(row.ID!)}`
                            )
                          }
                        />
                        <Tool
                          icon={Trash2}
                          label={t('common.delete')}
                          disabled={busy}
                          onClick={() =>
                            void requestCommand(
                              `${view === 'containers' ? 'container' : 'image'} rm ${dockerArgument(view === 'images' && row.Repository !== '<none>' && row.Tag !== '<none>' ? `${row.Repository}:${row.Tag}` : row.ID!)}`
                            )
                          }
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {busy
                  ? t('common.loading')
                  : snapshot
                    ? t('common.noData')
                    : t('docker.disconnected')}
              </div>
            )}
          </div>
        </>
      )}
      {(output || view === 'commands') && (
        <div
          data-testid="docker-output"
          className={`flex min-h-0 flex-col ${view === 'commands' ? 'flex-1' : 'h-[36%] min-h-32'}`}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs">
            <Terminal size={13} />
            <span className="min-w-0 flex-1 truncate font-mono" title={output?.command}>
              {output?.command || t('docker.output')}
            </span>
            {output && (
              <>
                <span className="shrink-0 tabular-nums">
                  Exit {output.result.exitCode} / {output.result.durationMs} ms
                </span>
                <Tool icon={X} label={t('docker.clearOutput')} onClick={() => setOutput(null)} />
              </>
            )}
          </div>
          {output?.result.truncated && (
            <p className="px-3 py-1 text-xs text-warning">{t('docker.truncated')}</p>
          )}
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/20 p-3 font-mono text-xs [overflow-wrap:anywhere]">
            {output
              ? `${output.result.stdout}${output.result.stderr ? `\n${output.result.stderr}` : ''}`
              : t('docker.noOutput')}
          </pre>
        </div>
      )}
      {editing && (
        <ProfileForm
          profile={editing}
          onClose={() => setEditing(null)}
          onSave={updated =>
            persist([...profiles.filter(item => item.id !== updated.id), updated], updated.id)
          }
        />
      )}
      {importOpen && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-3">
          <form
            role="dialog"
            aria-label={t('docker.importArchive')}
            onSubmit={event => void importArchive(event)}
            className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('docker.importArchive')}</h2>
              <Tool
                icon={X}
                label={t('common.close')}
                disabled={busy}
                onClick={() => setImportOpen(false)}
              />
            </div>
            <p className="mb-3 break-all text-sm">
              {t('docker.importTarget')}: <strong>{profile.name}</strong>
            </p>
            <label className="text-xs">
              {t('docker.archivePath')}
              <div className="mt-1 flex gap-1">
                <input
                  required
                  aria-label={t('docker.archivePath')}
                  disabled={busy}
                  value={archivePath}
                  onChange={event => setArchivePath(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm"
                />
                <Tool
                  icon={FolderOpen}
                  label={t('docker.chooseArchive')}
                  disabled={busy}
                  onClick={() => void browseArchive()}
                />
              </div>
            </label>
            <p className="mt-3 text-xs text-warning">{t('docker.importWarning')}</p>
            {error && (
              <p
                role="alert"
                className="mt-3 break-words text-xs text-destructive [overflow-wrap:anywhere]"
              >
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setImportOpen(false)}
                className="rounded px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || !archivePath.trim()}
                className="flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {t(busy ? 'docker.importing' : 'docker.importArchive')}
              </button>
            </div>
          </form>
        </div>
      )}
      <ConfirmDialog
        open={!!pending}
        title={t('docker.confirm')}
        message={pending ? `${pending.profile.name}\n${pending.command}` : ''}
        confirmLabel={t('common.execute')}
        variant="destructive"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) void execute(pending.command, pending.profile, true)
        }}
      />
      <ConfirmDialog
        open={removeProfile}
        title={t('docker.removeConnection')}
        message={profile.name}
        variant="destructive"
        onCancel={() => setRemoveProfile(false)}
        onConfirm={() => {
          const remaining = profiles.filter(item => item.id !== profile.id)
          const next = remaining.length ? remaining : [LOCAL_DOCKER]
          persist(next, next[0]!.id)
        }}
      />
    </section>
  )
}
