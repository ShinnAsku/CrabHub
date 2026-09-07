import { invoke, isTauri } from '@tauri-apps/api/core'

export type DockerConnection =
  | { kind: 'local'; endpoint: string }
  | {
      kind: 'ssh'
      host: string
      user: string
      port: number
      endpoint: string
      identityFile?: string
      knownHostsFile?: string
    }
export interface DockerProfile {
  id: string
  name: string
  connection: DockerConnection
}
export interface DockerOutput {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  truncated: boolean
}
export interface DockerPlan {
  arguments: string[]
  confirmationRequired: boolean
}
export type DockerRow = Record<string, string>
export const LOCAL_DOCKER: DockerProfile = {
  id: 'local',
  name: 'Local Docker',
  connection: { kind: 'local', endpoint: '' },
}

export function loadDockerProfiles(): DockerProfile[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('crabhub-docker-profiles') || 'null')
    if (!Array.isArray(saved)) return [LOCAL_DOCKER]
    const profiles: DockerProfile[] = []
    for (const profile of saved) {
      if (
        !profile ||
        typeof profile.id !== 'string' ||
        typeof profile.name !== 'string' ||
        !profile.name.trim()
      )
        continue
      const connection = profile.connection
      if (!connection || typeof connection.endpoint !== 'string') continue
      if (connection.kind === 'local')
        profiles.push({
          id: profile.id,
          name: profile.name,
          connection: { kind: 'local', endpoint: connection.endpoint },
        })
      if (
        connection.kind === 'ssh' &&
        typeof connection.host === 'string' &&
        typeof connection.user === 'string' &&
        Number.isInteger(connection.port) &&
        connection.port > 0 &&
        connection.port <= 65535
      ) {
        profiles.push({
          id: profile.id,
          name: profile.name,
          connection: {
            kind: 'ssh',
            host: connection.host,
            user: connection.user,
            port: connection.port,
            endpoint: connection.endpoint,
            identityFile:
              typeof connection.identityFile === 'string' ? connection.identityFile : '',
            knownHostsFile:
              typeof connection.knownHostsFile === 'string' ? connection.knownHostsFile : '',
          },
        })
      }
    }
    return profiles.length ? profiles : [LOCAL_DOCKER]
  } catch {
    return [LOCAL_DOCKER]
  }
}

export async function dockerPlan(command: string): Promise<DockerPlan> {
  if (!isTauri()) throw new Error('Docker management is available only in the desktop application.')
  return invoke('docker_plan', { command })
}

export async function dockerExecute(
  connection: DockerConnection,
  command: string,
  confirmed = false
): Promise<DockerOutput> {
  if (!isTauri()) throw new Error('Docker management is available only in the desktop application.')
  return invoke('docker_execute', { connection, command, confirmed })
}

export async function dockerLoad(
  connection: DockerConnection,
  path: string
): Promise<DockerOutput> {
  if (!isTauri()) throw new Error('Docker management is available only in the desktop application.')
  return invoke('docker_load', { connection, path, confirmed: true })
}

export function parseDockerRows(output: DockerOutput): DockerRow[] {
  if (output.exitCode !== 0)
    throw new Error(output.stderr || `Docker exited with code ${output.exitCode}`)
  if (output.truncated)
    throw new Error('Docker output exceeded 1 MiB. Narrow the command with a filter.')
  return output.stdout
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => {
      const row: unknown = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error('Invalid Docker JSON output.')
      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        ])
      )
    })
}

export async function dockerSnapshot(connection: DockerConnection) {
  const version = parseDockerRows(
    await dockerExecute(connection, "version --format '{{json .Server}}'")
  )[0]?.Version
  const containers = parseDockerRows(
    await dockerExecute(connection, "ps -a --no-trunc --format '{{json .}}'")
  )
  const images = parseDockerRows(
    await dockerExecute(connection, "image ls --no-trunc --format '{{json .}}'")
  )
  return { version: version || '?', containers, images }
}

export function dockerArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
