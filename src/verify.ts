import { snapshot, readMigrations, diffSnapshots, formatDiff } from './schema.ts'
import type { Bundle, Db, Diff, Migration, Snapshot } from './types.ts'

export interface Verification {
  ok: boolean
  target: Snapshot
  schemaDiff: Diff
  migrationDiff: { extra: string[], missing: string[] }
  liveMigrations: Migration[]
}

export async function verify(db: Db, bundle: Bundle): Promise<Verification> {
  const { target } = bundle
  const live = await snapshot(db)
  const liveMigrations = await readMigrations(db)

  const schemaDiff = diffSnapshots(live, target.schema)

  const key = (m: Migration): string => `${m.timestamp}:${m.name}`
  const expected = new Set(target.migrations.map(key))
  const actual = new Set(liveMigrations.map(key))
  const migrationDiff = {
    extra: [...actual].filter(m => !expected.has(m)),
    missing: [...expected].filter(m => !actual.has(m)),
  }

  const ok = schemaDiff.count === 0 && migrationDiff.extra.length === 0 && migrationDiff.missing.length === 0
  return { ok, target, schemaDiff, migrationDiff, liveMigrations }
}

export function formatVerify({ ok, target, schemaDiff, migrationDiff }: Verification): string {
  const label = target.ref.label
  if (ok) {
    return [
      `This database matches ${label}.`,
      `  schema:     identical (${target.schema.tables.length} tables, all columns, constraints, indexes and enum labels)`,
      `  migrations: ${target.migrations.length} rows, exactly the set ${label} expects`,
      '',
      `It is safe to start ${label} against it.`,
    ].join('\n')
  }

  const lines = [`This database does NOT match ${label}.`, '']
  if (schemaDiff.count > 0) {
    lines.push(`Schema differences: ${schemaDiff.count}`, formatDiff(schemaDiff, 'this database', label), '')
  }
  if (migrationDiff.extra.length || migrationDiff.missing.length) {
    lines.push('migrations table:')
    for (const m of migrationDiff.extra) lines.push(`  [unexpected] ${m}`)
    for (const m of migrationDiff.missing) lines.push(`  [missing]    ${m}`)
    lines.push('', 'Starting Misskey with this table wrong will replay or skip migrations.')
  }
  return lines.join('\n')
}
