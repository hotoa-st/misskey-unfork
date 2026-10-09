import { diffSnapshots } from './schema.ts'
import { deriveRepairs, droppedObjects } from './repairs.ts'
import type { DroppedColumn, Inventory, Schema, Snapshot } from './types.ts'

export function primaryKeyColumns(snapshot: Snapshot, table: string): string[] {
  const pk = snapshot.schema.constraints.find(c => c.table === table && c.def.startsWith('PRIMARY KEY'))
  const list = pk && /\((.*)\)/.exec(pk.def)?.[1]
  return list ? list.split(',').map(c => c.trim().replace(/^"(.*)"$/, '$1')) : ['id']
}

export function buildInventory(source: Snapshot, target: Snapshot): Inventory {
  const diff = diffSnapshots(source.schema, target.schema)
  const dropped = droppedObjects(diff)

  const droppedColumns = new Map<string, DroppedColumn[]>()
  for (const c of dropped.columns) {
    droppedColumns.set(c.table, [...(droppedColumns.get(c.table) ?? []), { name: c.name, type: c.type, default: c.default }])
  }
  for (const cols of droppedColumns.values()) cols.sort((a, b) => a.name.localeCompare(b.name))

  return {
    diff,
    droppedTables: [...dropped.tables].sort(),
    droppedColumns,
    repairs: deriveRepairs(source, target).repairs,
  }
}

// A drifted database may lack some of what the fork's fresh schema has; only
// what is there can be counted, saved or repaired.
export function presentIn(live: Schema, inventory: Inventory): Inventory {
  const tables = new Set(live.tables.map(t => t.name))
  const columns = new Set(live.columns.map(c => `${c.table}.${c.name}`))
  const has = (table: string, column?: string): boolean => tables.has(table) && (!column || columns.has(`${table}.${column}`))
  const droppedColumns = new Map<string, DroppedColumn[]>()
  for (const [table, cols] of inventory.droppedColumns) {
    const here = cols.filter(c => has(table, c.name))
    if (here.length) droppedColumns.set(table, here)
  }
  return {
    ...inventory,
    droppedTables: inventory.droppedTables.filter(t => has(t)),
    droppedColumns,
    repairs: inventory.repairs.filter(r => has(r.table)),
  }
}

export function interestingRowPredicate(columns: DroppedColumn[]): string {
  return columns.map((c) => {
    const col = `"${c.name}"`
    if (c.type === 'boolean') return `${col} IS TRUE`
    if (c.type.endsWith('[]')) return `(${col} IS NOT NULL AND cardinality(${col}) > 0)`
    return `${col} IS NOT NULL`
  }).join(' OR ')
}
