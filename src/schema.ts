// Catalog structure is compared as data rather than as pg_dump text, whose
// ordering and wording shift between Postgres versions. NOT NULL constraints
// are left out: Postgres 18 lists them in pg_constraint, older versions do
// not, and the columns section already records nullability.

import type { Db, Diff, Migration, Row, Schema, SectionDiff, SectionName, SectionRow } from './types.ts'

const QUERIES: Record<SectionName, string> = {
  tables: `
    SELECT c.relname AS name,
           obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`,

  columns: `
    SELECT c.relname AS "table",
           a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable,
           pg_get_expr(d.adbin, d.adrelid) AS "default",
           a.attidentity AS identity,
           col_description(c.oid, a.attnum) AS comment
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attname`,

  constraints: `
    SELECT c.relname AS "table",
           con.conname AS name,
           pg_get_constraintdef(con.oid) AS "def"
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND con.contype <> 'n'
    ORDER BY c.relname, con.conname`,

  indexes: `
    SELECT tablename AS "table", indexname AS name, indexdef AS "def"
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname`,

  enums: `
    SELECT t.typname AS name,
           array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname`,

  sequences: `
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
    ORDER BY c.relname`,

  extensions: `SELECT extname AS name FROM pg_extension ORDER BY extname`,
}

const SECTIONS = Object.keys(QUERIES) as SectionName[]

export async function snapshot(db: Pick<Db, 'query'>): Promise<Schema> {
  const out: Partial<Record<SectionName, Row[]>> = {}
  for (const key of SECTIONS) out[key] = await db.query(QUERIES[key])
  return out as unknown as Schema
}

export async function readMigrations(db: Pick<Db, 'query'>): Promise<Migration[]> {
  const rows = await db.query<{ timestamp: string | number, name: string }>(`SELECT "timestamp", "name" FROM "migrations" ORDER BY "timestamp", "name"`)
  return rows.map(r => ({ timestamp: Number(r.timestamp), name: r.name }))
}

type Keyed = { name: string, table?: string }

const keyOf = (row: Keyed): string => (row.table === undefined ? row.name : `${row.table}.${row.name}`)

function normalise<R extends Row>(row: R): R {
  const o: Row = {}
  for (const [k, v] of Object.entries(row)) o[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v
  return o as R
}

function sectionDiff<R extends Keyed & Row>(a: R[], b: R[]): SectionDiff<R> {
  const ma = new Map(a.map(r => [keyOf(r), normalise(r)]))
  const mb = new Map(b.map(r => [keyOf(r), normalise(r)]))
  const result: SectionDiff<R> = { onlyA: [], onlyB: [], changed: [] }

  for (const [k, ra] of ma) {
    const rb = mb.get(k)
    if (rb === undefined) {
      result.onlyA.push(ra)
      continue
    }
    if (JSON.stringify(ra) !== JSON.stringify(rb)) result.changed.push({ key: k, a: ra, b: rb })
  }
  for (const [k, rb] of mb) if (!ma.has(k)) result.onlyB.push(rb)

  return result
}

export function diffSnapshots(a: Schema, b: Schema): Diff {
  const result: Diff = { sections: {}, count: 0 }
  for (const name of SECTIONS) {
    const d = sectionDiff((a[name] ?? []) as unknown as (Keyed & Row)[], (b[name] ?? []) as unknown as (Keyed & Row)[])
    const n = d.onlyA.length + d.onlyB.length + d.changed.length
    if (n > 0) {
      result.sections[name] = d as never
      result.count += n
    }
  }
  return result
}

export function section<K extends SectionName>(diff: Diff, name: K): SectionDiff<SectionRow<K>> {
  return (diff.sections[name] ?? { onlyA: [], onlyB: [], changed: [] }) as SectionDiff<SectionRow<K>>
}

export function formatDiff(diff: Diff, labelA = 'actual', labelB = 'expected'): string {
  if (diff.count === 0) return '(no differences)'
  const lines: string[] = []
  const describe = (r: Row): string => `${r.def ? `  ${r.def}` : ''}${r.type ? `  ${r.type}` : ''}`
  for (const name of SECTIONS) {
    const d = diff.sections[name] as SectionDiff<Keyed & Row> | undefined
    if (!d) continue
    lines.push(`\n## ${name}`)
    for (const r of d.onlyA) lines.push(`  [only in ${labelA}] ${keyOf(r)}${describe(r)}`)
    for (const r of d.onlyB) lines.push(`  [only in ${labelB}] ${keyOf(r)}${describe(r)}`)
    for (const c of d.changed) {
      lines.push(`  [differs] ${c.key}`)
      for (const k of Object.keys(c.a)) {
        if (JSON.stringify(c.a[k]) !== JSON.stringify(c.b[k])) {
          lines.push(`      ${k}: ${labelA}=${JSON.stringify(c.a[k])}  ${labelB}=${JSON.stringify(c.b[k])}`)
        }
      }
    }
  }
  return lines.join('\n')
}
