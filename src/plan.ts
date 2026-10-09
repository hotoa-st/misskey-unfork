import { snapshot, readMigrations, diffSnapshots, formatDiff } from './schema.ts'
import { buildInventory, interestingRowPredicate, presentIn } from './inventory.ts'
import { checkPasswords, type PasswordScheme } from './login.ts'
import type { Bundle, Db, Diff, DroppedColumn, Inventory, Migration, Schema } from './types.ts'

const SECRET = /secret|key|token|pass|credential/i

interface Loss {
  table: string
  rows: number | '?'
  detail: string
}

interface Setting {
  name: string
  value: string
}

export interface Plan {
  bundle: Bundle
  inventory: Inventory
  live: Schema
  liveMigrations: Migration[]
  drift: Diff
  work: Diff
  lost: Loss[]
  rewritten: Loss[]
  settings: Setting[]
  passwords: PasswordScheme[]
}

async function count(db: Db, table: string, where: string): Promise<number> {
  const rows = await db.query<{ n: string | number }>(`SELECT count(*)::bigint AS n FROM "${table}" WHERE ${where}`)
  return Number(rows[0].n)
}

function isSet(value: unknown): boolean {
  return !(value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0))
}

async function lostSettings(db: Db, columns: DroppedColumn[]): Promise<Setting[]> {
  if (columns.length === 0) return []
  const select = columns.map(c => `"${c.name}", ("${c.name}" IS DISTINCT FROM ${c.default ?? 'NULL'}) AS "${c.name}:changed"`)
  const rows = await db.query(`SELECT ${select.join(', ')} FROM "meta" LIMIT 1`)
  if (rows.length === 0) return []
  const row = rows[0]
  return columns.filter(c => row[`${c.name}:changed`] && isSet(row[c.name])).map((c) => {
    const shown = SECRET.test(c.name) ? '(set)' : JSON.stringify(row[c.name])
    return { name: c.name, value: shown.length > 60 ? `${shown.slice(0, 57)}...` : shown }
  })
}

export async function collectPlan(db: Db, bundle: Bundle): Promise<Plan> {
  const { source, target } = bundle
  const inventory = buildInventory(source, target)

  const live = await snapshot(db)
  const liveMigrations = await readMigrations(db)
  const drift = diffSnapshots(live, source.schema)
  const work = diffSnapshots(live, target.schema)

  const here = presentIn(live, inventory)

  const lost: Loss[] = []
  for (const table of here.droppedTables) {
    lost.push({ table, rows: await count(db, table, 'TRUE'), detail: 'whole table dropped' })
  }
  for (const [table, columns] of here.droppedColumns) {
    const rows = await count(db, table, `(${interestingRowPredicate(columns)})`)
    if (rows > 0) lost.push({ table, rows, detail: `${columns.length} column(s) dropped: ${columns.map(c => c.name).join(', ')}` })
  }
  const rewritten: Loss[] = []
  for (const r of here.repairs) {
    const rows = await count(db, r.table, r.where).catch(() => null)
    if (rows === null) {
      lost.push({ table: r.table, rows: '?', detail: `${r.reason} (could not be counted: the database differs from ${source.ref.label} here)` })
    }
    else if (rows > 0) {
      (r.kind === 'delete' ? lost : rewritten).push({ table: r.table, rows, detail: r.reason })
    }
  }

  const settings = await lostSettings(db, here.droppedColumns.get('meta') ?? [])
  const passwords = await checkPasswords(db, bundle.meta.passwordVerifiers)

  return { bundle, inventory, live, liveMigrations, drift, work, lost, rewritten, settings, passwords }
}

function table(rows: Loss[]): string[] {
  const width = Math.max(...rows.map(l => l.table.length))
  return rows.map(l => `  ${l.table.padEnd(width)}  ${String(l.rows).padStart(9)} row(s)  ${l.detail}`)
}

export function formatPlan(plan: Plan): string {
  const { bundle, drift, work, lost, rewritten, settings, passwords, liveMigrations } = plan
  const { source, target } = bundle
  const lines = [`Reverting ${bundle.label}`, '']

  if (drift.count === 0) {
    lines.push(`This database matches ${source.ref.label}'s schema exactly.`)
  }
  else {
    lines.push(
      `WARNING: this database differs from ${source.ref.label} in ${drift.count} place(s).`,
      'The revert was generated for that exact schema and does not account for anything below.',
      formatDiff(drift, 'this database', source.ref.label),
    )
  }
  lines.push('', `migrations table: ${liveMigrations.length} row(s) now, ${target.migrations.length} after the revert`, '')

  lines.push(`Schema changes to apply: ${work.count}`)
  for (const [name, d] of Object.entries(work.sections)) {
    lines.push(`  ${name}: ${d.onlyA.length} to remove, ${d.onlyB.length} to add, ${d.changed.length} to alter`)
  }
  lines.push('')

  if (bundle.meta.warnings.length) {
    lines.push('Warnings from generation:', ...bundle.meta.warnings.map(w => `  ${w}`), '')
  }

  lines.push('Data that will be lost' + (lost.length ? ' (`unfork backup` saves it first):' : ': none'), ...table(lost), '')
  lines.push('Data that will be rewritten' + (rewritten.length ? ':' : ': none'), ...table(rewritten), '')

  lines.push('Instance settings that will be lost (changed from the default)' + (settings.length ? ':' : ': none'))
  for (const s of settings) lines.push(`  ${s.name} = ${s.value}`)
  lines.push('')

  lines.push('Login:')
  const verifiers = bundle.meta.passwordVerifiers
  if (passwords.length === 0) {
    lines.push('  no local accounts with a password')
  }
  else if (!verifiers) {
    lines.push(`  could not tell which password hashes ${target.ref.label} verifies; check them yourself:`)
    for (const p of passwords) lines.push(`  ${String(p.accounts).padStart(9)} account(s) hashed with ${p.scheme}`)
  }
  else {
    for (const p of passwords) {
      lines.push(`  ${String(p.accounts).padStart(9)} account(s) hashed with ${p.algorithm ?? p.scheme}: ${p.verifiable ? 'ok' : `${target.ref.label} cannot verify these`}`)
    }
    if (passwords.some(p => !p.verifiable)) {
      lines.push('  Those accounts cannot log in until their password is reset (admin reset or email reset).')
      lines.push(`  ${target.ref.label} verifies: ${verifiers.join(', ')}.`)
    }
  }
  lines.push('')

  lines.push(
    'After the revert:',
    `  start exactly ${target.ref.label} first, then upgrade as usual`,
    '  flush Redis: queued jobs from the fork cannot be read by Misskey',
    '  fork-only keys in default.yml are ignored; fork-only features are gone with the data above',
  )
  return lines.join('\n')
}
