import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { buildInventory, interestingRowPredicate, primaryKeyColumns, presentIn } from './inventory.ts'
import { snapshot } from './schema.ts'
import type { Bundle, Db, Ref, Row } from './types.ts'

const MANIFEST = 'manifest.json'

interface Extract {
  file: string
  rows: number
  kind: string
  table: string
  columns?: string[]
  reason?: string
}

export interface Manifest {
  createdAt: string
  database: string
  from: Ref
  to: Ref
  dump: { file: string, bytes: number, format: string } | null
  extracts: Extract[]
  extractsSkipped?: boolean
}

export async function runBackup(db: Db, dir: string, bundle: Bundle, { label = 'this database', extracts = true } = {}): Promise<Manifest> {
  mkdirSync(dir, { recursive: true })
  const { droppedTables, droppedColumns, repairs } = presentIn(await snapshot(db), buildInventory(bundle.source, bundle.target))

  const manifest: Manifest = {
    createdAt: new Date().toISOString(),
    database: label,
    from: bundle.source.ref,
    to: bundle.target.ref,
    dump: null,
    extracts: [],
  }

  const dumpFile = path.join(dir, 'full.dump')
  process.stdout.write('  pg_dump (full database) ... ')
  await db.dump(dumpFile)
  const bytes = statSync(dumpFile).size
  manifest.dump = { file: 'full.dump', bytes, format: 'custom (restore with pg_restore)' }
  console.log(`${(bytes / 1024 / 1024).toFixed(1)} MiB`)

  const finish = (): Manifest => {
    writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, '\t') + '\n')
    return manifest
  }

  if (!extracts) {
    manifest.extractsSkipped = true
    console.log('  extracts skipped (--skip-extracts); the full dump still holds everything')
    return finish()
  }

  const write = (name: string, rows: Row[], meta: Omit<Extract, 'file' | 'rows'>): void => {
    if (rows.length === 0) return
    const file = `${name}.json`
    writeFileSync(path.join(dir, file), JSON.stringify({ ...meta, rows }, null, '\t'))
    manifest.extracts.push({ file, rows: rows.length, ...meta })
    console.log(`  ${file}: ${rows.length} row(s)`)
  }

  for (const table of droppedTables) {
    write(`table-${table}`, await db.query(`SELECT * FROM "${table}"`), { kind: 'dropped-table', table })
  }
  for (const [table, columns] of droppedColumns) {
    const cols = [...primaryKeyColumns(bundle.source, table), ...columns.map(c => c.name)].map(c => `"${c}"`).join(', ')
    const rows = await db.query(`SELECT ${cols} FROM "${table}" WHERE (${interestingRowPredicate(columns)})`)
    write(`columns-${table}`, rows, { kind: 'dropped-columns', table, columns: columns.map(c => c.name) })
  }
  for (const [i, r] of repairs.entries()) {
    if (r.kind !== 'delete') continue
    const rows = await db.query(`SELECT * FROM "${r.table}" WHERE ${r.where}`).catch(() => null)
    if (rows === null) {
      console.log(`  rows-${r.table}-${i}: skipped, the database differs from ${bundle.source.ref.label} here`)
      continue
    }
    write(`rows-${r.table}-${i}`, rows, { kind: 'deleted-rows', table: r.table, reason: r.reason })
  }
  return finish()
}

export function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')) as Manifest
  }
  catch {
    return null
  }
}
