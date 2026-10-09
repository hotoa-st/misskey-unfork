// Each repair carries its WHERE clause so plan, backup and revert.sql agree on the rows.

import { diffSnapshots, section } from './schema.ts'
import type { ColumnRow, Diff, Repair, Snapshot } from './types.ts'

interface Labels {
  source: string
  target: string
}

interface Dropped {
  tables: Set<string>
  columns: ColumnRow[]
  has: (table: string, name: string) => boolean
}

interface UniqueKey {
  table: string
  name: string
  columns: string[]
}

export const q = (name: string): string => `"${name}"`
export const literal = (s: unknown): string => `'${String(s).replace(/'/g, '\'\'')}'`
const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, '$1')

function plainColumnList(list: string): string[] | null {
  const columns = list.split(',').map(unquote)
  return columns.every(c => /^\w+$/.test(c)) ? columns : null
}

export function droppedObjects(diff: Diff): Dropped {
  const tables = new Set(section(diff, 'tables').onlyA.map(t => t.name))
  const columns = section(diff, 'columns').onlyA.filter(c => !tables.has(c.table))
  const has = (table: string, name: string): boolean => tables.has(table) || columns.some(c => c.table === table && c.name === name)
  return { tables, columns, has }
}

function removedEnumLabels(diff: Diff, source: Snapshot, dropped: Dropped, labels: Labels): Repair[] {
  const repairs: Repair[] = []
  for (const change of section(diff, 'enums').changed) {
    const removed = change.a.labels.filter(l => !change.b.labels.includes(l))
    if (removed.length === 0) continue
    const list = removed.map(literal).join(', ')
    const reason = `${labels.target} has no ${change.key} value ${removed.join(', ')}`

    for (const col of source.schema.columns) {
      if (dropped.has(col.table, col.name)) continue
      const c = q(col.name)
      if (col.type === change.key) {
        repairs.push(col.nullable
          ? { phase: 'pre', kind: 'update', table: col.table, set: `${c} = NULL`, where: `${c}::text IN (${list})`, reason }
          : { phase: 'pre', kind: 'delete', table: col.table, where: `${c}::text IN (${list})`, reason })
      }
      else if (col.type === `${change.key}[]`) {
        repairs.push({
          phase: 'pre',
          kind: 'update',
          table: col.table,
          set: `${c} = ARRAY(SELECT u.x FROM unnest(${c}) WITH ORDINALITY u(x, n) WHERE u.x::text NOT IN (${list}) ORDER BY u.n)`,
          where: `${c}::text[] && ARRAY[${list}]`,
          reason,
        })
      }
    }
  }
  return repairs
}

function uniqueKeys(diff: Diff, sourceTables: Set<string>): { keys: UniqueKey[], warnings: string[] } {
  const keys = new Map<string, UniqueKey>()
  const warnings: string[] = []
  const add = (table: string, name: string, list: string): void => {
    if (!sourceTables.has(table)) return
    const columns = plainColumnList(list)
    if (!columns) {
      warnings.push(`${table}.${name} is unique over an expression; duplicates are not removed automatically`)
      return
    }
    keys.set(`${table}(${columns.join(',')})`, { table, name, columns })
  }

  for (const i of section(diff, 'indexes').onlyB) {
    const m = /^CREATE UNIQUE INDEX .* USING \w+ \((.*)\)(\s+WHERE\s.*)?$/.exec(i.def)
    if (!m) continue
    if (m[2]) {
      warnings.push(`${i.table}.${i.name} is a partial unique index; duplicates are not removed automatically`)
      continue
    }
    add(i.table, i.name, m[1])
  }
  for (const c of section(diff, 'constraints').onlyB) {
    const m = /^(?:UNIQUE|PRIMARY KEY) \((.*)\)$/.exec(c.def)
    if (m) add(c.table, c.name, m[1])
  }
  return { keys: [...keys.values()], warnings }
}

function duplicateRows(diff: Diff, source: Snapshot, labels: Labels): { repairs: Repair[], warnings: string[] } {
  const sourceTables = new Set(source.schema.tables.map(t => t.name))
  const { keys, warnings } = uniqueKeys(diff, sourceTables)
  const repairs = keys.map(({ table, name, columns }): Repair => {
    const order = source.schema.columns.some(c => c.table === table && c.name === 'id') ? '"id"' : 'ctid'
    const on = columns.map(c => `a.${q(c)} = b.${q(c)}`).join(' AND ')
    return {
      phase: 'pre',
      kind: 'delete',
      table,
      where: `ctid IN (SELECT a.ctid FROM ${q(table)} a JOIN ${q(table)} b ON ${on} AND a.${order} > b.${order})`,
      reason: `later duplicates of (${columns.join(', ')}); ${labels.target} enforces ${name}`,
    }
  })
  return { repairs, warnings }
}

function orphanRows(diff: Diff, source: Snapshot, labels: Labels): Repair[] {
  const repairs: Repair[] = []
  const sourceTables = new Set(source.schema.tables.map(t => t.name))
  for (const c of section(diff, 'constraints').onlyB) {
    const m = /^FOREIGN KEY \((.*?)\) REFERENCES (\S+?)\((.*?)\)/.exec(c.def)
    if (!m || !sourceTables.has(c.table)) continue
    const columns = m[1].split(',').map(unquote)
    const ref = unquote(m[2].replace(/^\w+\./, ''))
    const refColumns = m[3].split(',').map(unquote)
    const t = q(c.table)

    const present = columns.map(col => `${t}.${q(col)} IS NOT NULL`).join(' AND ')
    const match = columns.map((col, i) => `r.${q(refColumns[i])} = ${t}.${q(col)}`).join(' AND ')
    const where = `${present} AND NOT EXISTS (SELECT 1 FROM ${q(ref)} r WHERE ${match})`
    const reason = `rows pointing at a missing ${ref}; ${labels.target} enforces ${c.name}`
    const nullable = columns.every(col => source.schema.columns.find(s => s.table === c.table && s.name === col)?.nullable)

    repairs.push(nullable
      ? { phase: 'pre', kind: 'update', table: c.table, set: columns.map(col => `${q(col)} = NULL`).join(', '), where, reason }
      : { phase: 'pre', kind: 'delete', table: c.table, where, reason })
  }
  return repairs
}

const jsonbArrayLiteral = (def: string | null): boolean => /^'\[/.test(def ?? '')

function changedDefaults(diff: Diff, dropped: Dropped, labels: Labels): Repair[] {
  const repairs: Repair[] = []
  for (const { a, b } of section(diff, 'columns').changed) {
    if (a.default === b.default || !a.default || !b.default || dropped.has(b.table, b.name)) continue
    const c = q(b.name)
    const reason = `values that ${labels.source} set by default and ${labels.target} does not`

    if (b.type.endsWith('[]')) {
      const removed = `ARRAY(SELECT unnest(${a.default}) EXCEPT SELECT unnest(${b.default}))`
      repairs.push({
        phase: 'post',
        kind: 'update',
        table: b.table,
        set: `${c} = ARRAY(SELECT u.x FROM unnest(${c}) WITH ORDINALITY u(x, n) WHERE NOT (u.x = ANY (${removed})) ORDER BY u.n)`,
        where: `${c} && ${removed}`,
        reason,
      })
    }
    else if (b.type === 'jsonb' && jsonbArrayLiteral(a.default) && jsonbArrayLiteral(b.default)) {
      const removed = `(SELECT COALESCE(jsonb_agg(old.v), '[]'::jsonb) FROM jsonb_array_elements(${a.default}) old(v) WHERE NOT (${b.default} @> jsonb_build_array(old.v)))`
      repairs.push({
        phase: 'post',
        kind: 'update',
        table: b.table,
        set: `${c} = COALESCE((SELECT jsonb_agg(cur.v ORDER BY cur.n) FROM jsonb_array_elements(${c}) WITH ORDINALITY cur(v, n) WHERE NOT (${removed} @> jsonb_build_array(cur.v))), '[]'::jsonb)`,
        where: `jsonb_typeof(${c}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${c}) cur(v) WHERE ${removed} @> jsonb_build_array(cur.v))`,
        reason,
      })
    }
    else {
      repairs.push({
        phase: 'post',
        kind: 'update',
        table: b.table,
        set: `${c} = ${b.default}`,
        where: `${c} = ${a.default}`,
        reason: `the ${labels.source} default, replaced by the ${labels.target} default`,
      })
    }
  }
  return repairs
}

export function deriveRepairs(source: Snapshot, target: Snapshot): { repairs: Repair[], warnings: string[] } {
  const diff = diffSnapshots(source.schema, target.schema)
  const dropped = droppedObjects(diff)
  const labels = { source: source.ref.label, target: target.ref.label }
  const duplicates = duplicateRows(diff, source, labels)
  return {
    repairs: [
      ...removedEnumLabels(diff, source, dropped, labels),
      ...duplicates.repairs,
      ...orphanRows(diff, source, labels),
      ...changedDefaults(diff, dropped, labels),
    ],
    warnings: duplicates.warnings,
  }
}

export function repairSql(r: Repair): string {
  return r.kind === 'delete'
    ? `DELETE FROM ${q(r.table)} WHERE ${r.where};`
    : `UPDATE ${q(r.table)} SET ${r.set} WHERE ${r.where};`
}
