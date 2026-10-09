import path from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { ROOT } from '../src/repos.ts'
import { psql, type Postgres } from '../src/docker.ts'
import { applyMigrations } from '../src/reference.ts'
import type { Bundle } from '../src/types.ts'

export const checks = { failures: 0 }

export function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`)
  if (!ok) checks.failures++
}

export const indent = (text: string): string => text.split('\n').map(l => `    ${l}`).join('\n')

export const passthrough = (name: string, value: string | undefined): string[] => (value === undefined ? [] : [`--${name}`, value])

export function cli(args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: ROOT })
  if (r.error) throw r.error
  return r
}

export const scalar = (pg: Postgres, db: string, sql: string): string =>
  psql(pg.container, db, `\\pset tuples_only on\n\\pset format unaligned\n${sql}\n`).trim()

export function sharedTables(bundle: Bundle): string[] {
  const target = new Set(bundle.target.schema.tables.map(t => t.name))
  return bundle.source.schema.tables.map(t => t.name).filter(t => target.has(t) && t !== 'migrations')
}

export const rowCounts = (pg: Postgres, db: string, tables: string[]): Record<string, string> =>
  Object.fromEntries(tables.map(t => [t, scalar(pg, db, `SELECT count(*) FROM "${t}";`)]))

export const tablesTrimmedBy = (bundle: Bundle, tables: string[]): Set<string> =>
  new Set(tables.filter(t => new RegExp(`^DELETE FROM "${t}" `, 'm').test(bundle.sql)))

export interface Judgement {
  pg: Postgres
  db: string
  work: string
  bundle: Bundle
  bundleDir: string
  backupDir: string
  expectDrift?: boolean
}

export async function revertAndJudge({ pg, db, work, bundle, bundleDir, backupDir, expectDrift = false }: Judgement): Promise<void> {
  const shared = sharedTables(bundle)
  const before = rowCounts(pg, db, shared)
  const trimmed = tablesTrimmedBy(bundle, shared)
  const conn = ['--bundle', bundleDir, '--docker', pg.container, '--user', 'postgres', '--database', db]

  console.log('\n[plan]')
  const plan = cli(['plan', ...conn])
  process.stdout.write(indent(plan.stdout) + '\n')
  check('plan exits cleanly', plan.status === 0, plan.stderr.trim())
  if (expectDrift) console.log('    (drift is expected: the restore did not reproduce the source schema exactly)')
  else check('plan finds no drift from the fork schema', /matches .* schema exactly/.test(plan.stdout))

  console.log('\n[backup + apply]')
  const backup = cli(['backup', ...conn, '--backup-dir', backupDir])
  check('backup exits cleanly', backup.status === 0, backup.stderr.trim())

  const apply = cli(['apply', ...conn, '--backup-dir', backupDir, '--yes', ...(expectDrift ? ['--allow-drift'] : [])])
  process.stdout.write(indent(apply.stdout.split('\n').slice(-8).join('\n')) + '\n')
  check('apply exits cleanly', apply.status === 0, (apply.stderr || apply.stdout).trim().split('\n').slice(-5).join('\n'))

  console.log('\n[verify + data survival]')
  const v = cli(['verify', ...conn])
  check('verify reports an exact match', v.status === 0, v.stdout.trim().split('\n').slice(-3).join(' '))

  const after = rowCounts(pg, db, shared)
  for (const t of shared) {
    if (before[t] === '0') continue
    if (trimmed.has(t)) {
      check(`${t}: rows kept or trimmed by a listed repair`, Number(after[t]) <= Number(before[t]) && Number(after[t]) > 0, `${before[t]} -> ${after[t]}`)
    }
    else {
      check(`${t}: rows kept`, after[t] === before[t], `${before[t]} -> ${after[t]}`)
    }
  }

  const { meta } = bundle
  console.log(`\n[${bundle.target.ref.label}'s own migration runner]`)
  const output = await applyMigrations(work, { id: `misskey-${meta.base.tag}`, repoDir: meta.base.cacheDir, sha: meta.base.sha, ref: bundle.target.ref },
    { images: meta.images, config: meta.config, network: pg.network, container: pg.container, database: db })
  console.log(indent(output.split('\n').slice(-3).join('\n')))
  check(`${bundle.target.ref.label} finds no migrations left to run`, /applied 0 migrations/.test(output), output.split('\n').slice(-2).join(' '))
}

export function summary(): number {
  console.log(`\n${checks.failures === 0 ? 'all checks passed' : `${checks.failures} check(s) FAILED`}`)
  return checks.failures === 0 ? 0 : 1
}
