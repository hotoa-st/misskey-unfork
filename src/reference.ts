import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, cpSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { ROOT, exportTree, readFileAt } from './repos.ts'
import { MIGRATIONS_DIR } from './base.ts'
import { dockerStream, psql, startPostgres, stopPostgres } from './docker.ts'
import type { Db, Images, MigrationConfig, Snapshot, Variant } from './types.ts'

const RUNNER_DEPS = ['typeorm', 'pg', 'reflect-metadata']
const RUNNER_FILES = ['schema.ts', 'types.ts']

// One upstream migration bakes these default.yml values into column DEFAULTs,
// so the snapshots have to be built with the instance's own values.
export const DEFAULT_CONFIG: MigrationConfig = { disallowExternalApRedirect: false, proxyRemoteFiles: false, signToActivityPubGet: true }

const CONFIG_COLUMNS: Record<string, keyof MigrationConfig> = {
  proxyRemoteFiles: 'proxyRemoteFiles',
  signToActivityPubGet: 'signToActivityPubGet',
  allowExternalApRedirect: 'disallowExternalApRedirect',
}

export interface RunnerTarget {
  images: Images
  network: string
  container: string
  database: string
  config: MigrationConfig
}

export function configFromFile(file: string): MigrationConfig {
  const cfg = (yaml.load(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>
  const out = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof MigrationConfig)[]) {
    if (cfg[key] !== undefined) out[key] = Boolean(cfg[key])
  }
  return out
}

export async function configFromDatabase(db: Db): Promise<MigrationConfig> {
  const rows = await db.query<{ name: string, default: string | null }>(`
    SELECT column_name AS name, column_default AS "default"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'meta'
      AND column_name IN (${Object.keys(CONFIG_COLUMNS).map(c => `'${c}'`).join(', ')})`)
  const out = { ...DEFAULT_CONFIG }
  for (const r of rows) {
    const value = r.default === 'true'
    const key = CONFIG_COLUMNS[r.name]
    out[key] = key === 'disallowExternalApRedirect' ? !value : value
  }
  return out
}

export function imagesFor(repoDir: string, rev: string, postgresImage?: string): Images {
  const nodeMajor = readFileAt(repoDir, rev, '.node-version')?.trim().split('.')[0]
  const postgres = /image:\s*(postgres:\S+)/.exec(readFileAt(repoDir, rev, 'compose_example.yml') ?? '')?.[1]
  return {
    node: nodeMajor ? `node:${nodeMajor}-bookworm-slim` : 'node:22-bookworm-slim',
    postgres: postgresImage ?? postgres ?? 'postgres:15-alpine',
  }
}

// The catalog differs between Postgres majors, so the snapshots are built on
// the same major the instance runs.
export async function postgresImageOf(db: Db): Promise<string> {
  const [{ version }] = await db.query<{ version: string }>('SELECT current_setting(\'server_version\') AS version')
  return `postgres:${version.split('.')[0]}-alpine`
}

function packagesImportedBy(dir: string): string[] {
  const found = new Set<string>()
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.[cm]?js$/.test(entry.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/(?:from\s+|require\()\s*['"]([^'"]+)['"]/g)) found.add(m[1])
      }
    }
  }
  walk(dir)
  return [...found]
    .filter(s => !/^(node:|\.|\/)/.test(s) && !builtinModules.includes(s))
    .map(s => s.split('/').slice(0, s.startsWith('@') ? 2 : 1).join('/'))
}

export function prepareVariant(work: string, { id, repoDir, sha }: Variant, config: MigrationConfig = DEFAULT_CONFIG): string {
  const dir = path.join(work, id)
  exportTree(repoDir, sha, MIGRATIONS_DIR, path.join(dir, 'migration'))

  mkdirSync(path.join(dir, 'built'), { recursive: true })
  writeFileSync(path.join(dir, 'built', 'config.js'), 'export const path = \'/work/default.yml\';\n')
  writeFileSync(path.join(dir, 'default.yml'), yaml.dump(config))
  for (const f of RUNNER_FILES) cpSync(path.join(ROOT, 'src', f), path.join(dir, f))
  cpSync(path.join(ROOT, 'src', 'container', 'run-migrations.ts'), path.join(dir, 'run-migrations.ts'))

  const backend = JSON.parse(readFileAt(repoDir, sha, 'packages/backend/package.json') ?? '{}') as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const versions = { ...backend.devDependencies, ...backend.dependencies }
  const dependencies: Record<string, string> = {}
  for (const name of new Set([...RUNNER_DEPS, ...packagesImportedBy(path.join(dir, 'migration'))])) {
    dependencies[name] = versions[name] ?? 'latest'
  }
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'migration-runner', private: true, type: 'module', dependencies }, null, '\t'))
  return dir
}

export const installDependencies = (dir: string, nodeImage: string): Promise<void> =>
  dockerStream(['run', '--rm', '-v', `${dir}:/work`, '-w', '/work', nodeImage,
    'npm', 'install', '--no-audit', '--no-fund', '--loglevel=error'])

export const migrationRunner = ({ dir, nodeImage, network, dbUrl }: { dir: string, nodeImage: string, network: string, dbUrl: string }): string[] => [
  'run', '--rm', '--network', network, '-v', `${dir}:/work`, '-w', '/work', nodeImage,
  'node', '--experimental-strip-types', '--no-warnings', 'run-migrations.ts',
  '--migrations', '/work/migration', '--out', '/work/snapshot.json', '--db', dbUrl,
]

export const readSnapshot = (dir: string): Snapshot => JSON.parse(readFileSync(path.join(dir, 'snapshot.json'), 'utf8')) as Snapshot

export async function applyMigrations(work: string, variant: Variant, { images, network, container, database, config }: RunnerTarget): Promise<string> {
  const dir = prepareVariant(work, variant, config)
  await installDependencies(dir, images.node)
  const r = spawnSync('docker', migrationRunner({
    dir, nodeImage: images.node, network, dbUrl: `postgres://postgres:postgres@${container}:5432/${database}`,
  }), { encoding: 'utf8' })
  return `${r.stdout}${r.stderr}`.trim()
}

export const databaseNameFor = (id: string): string => `db_${id.replace(/\W/g, '_').toLowerCase()}`

export async function buildSnapshots(variants: Variant[], images: Images, config: MigrationConfig): Promise<Record<string, Snapshot>> {
  const work = path.join(tmpdir(), `unfork-ref-${process.pid}`)
  const pg = { container: 'unfork-ref-pg', network: 'unfork-ref-net', image: images.postgres }
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  await startPostgres(pg)

  try {
    const snapshots: Record<string, Snapshot> = {}
    for (const variant of variants) {
      console.log(`\n=== ${variant.ref.label} ===`)
      const dir = prepareVariant(work, variant, config)
      await installDependencies(dir, images.node)
      const db = databaseNameFor(variant.id)
      psql(pg.container, 'postgres', `DROP DATABASE IF EXISTS ${db};\nCREATE DATABASE ${db};\n`)
      await dockerStream(migrationRunner({
        dir, nodeImage: images.node, network: pg.network,
        dbUrl: `postgres://postgres:postgres@${pg.container}:5432/${db}`,
      }))
      const snap = readSnapshot(dir)
      snap.ref = { ...variant.ref, builtAt: new Date().toISOString(), postgresImage: images.postgres }
      snapshots[variant.id] = snap
    }
    return snapshots
  }
  finally {
    stopPostgres(pg)
    rmSync(work, { recursive: true, force: true })
  }
}
