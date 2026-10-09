import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

export interface Postgres {
  container: string
  network: string
}

export function run(cmd: string, args: string[], opts: Partial<SpawnSyncOptionsWithStringEncoding> = {}): SpawnSyncReturns<string> {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

export function docker(args: string[], { check = true } = {}): SpawnSyncReturns<string> {
  const r = run('docker', args)
  if (check && r.status !== 0) throw new Error(`docker ${args.join(' ')} failed (${r.status})\n${r.stderr}`)
  return r
}

export function dockerStream(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: 'inherit' })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited ${code}`))))
  })
}

// The image starts a throwaway server during initialisation and stops it
// again, so one successful probe is not enough.
export async function waitForPostgres(container: string, { timeoutMs = 120_000 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (let ready = 0; ready < 2;) {
    ready = run('docker', ['exec', container, 'pg_isready', '-U', 'postgres']).status === 0 ? ready + 1 : 0
    if (Date.now() > deadline) throw new Error(`postgres in ${container} not ready after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 1000))
  }
}

export function psql(container: string, db: string, sql: string): string {
  const r = run('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql })
  if (r.status !== 0) throw new Error(`psql failed:\n${r.stderr}\n${r.stdout}`)
  return r.stdout
}

export function startPostgres({ container, network, image, publishPort }: Postgres & { image: string, publishPort?: number }): Promise<void> {
  run('docker', ['rm', '-f', container])
  run('docker', ['network', 'rm', network])
  docker(['network', 'create', network])
  docker([
    'run', '-d', '--name', container, '--network', network,
    ...(publishPort ? ['-p', `${publishPort}:5432`] : []),
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_USER=postgres', image,
  ])
  return waitForPostgres(container)
}

export function stopPostgres({ container, network }: Postgres): void {
  run('docker', ['rm', '-f', container])
  run('docker', ['network', 'rm', network])
}
