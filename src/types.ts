export interface TableRow {
  name: string
  comment: string | null
}

export interface ColumnRow {
  table: string
  name: string
  type: string
  nullable: boolean
  default: string | null
  identity: string
  comment: string | null
}

export interface DefRow {
  table: string
  name: string
  def: string
}

export interface EnumRow {
  name: string
  labels: string[]
}

export interface NamedRow {
  name: string
}

export interface Schema {
  tables: TableRow[]
  columns: ColumnRow[]
  constraints: DefRow[]
  indexes: DefRow[]
  enums: EnumRow[]
  sequences: NamedRow[]
  extensions: NamedRow[]
}

export type SectionName = keyof Schema
export type SectionRow<K extends SectionName> = Schema[K][number]

export interface Migration {
  timestamp: number
  name: string
}

export interface Ref {
  label: string
  rev: string
  sha: string
  repository?: string
  builtAt?: string
  postgresImage?: string
}

export interface Snapshot {
  schema: Schema
  migrations: Migration[]
  ref: Ref
}

export interface Change<R> {
  key: string
  a: R
  b: R
}

export interface SectionDiff<R> {
  onlyA: R[]
  onlyB: R[]
  changed: Change<R>[]
}

export type Sections = { [K in SectionName]?: SectionDiff<SectionRow<K>> }

export interface Diff {
  sections: Sections
  count: number
}

export type Row = Record<string, unknown>

export interface Db {
  query<T extends Row = Row>(sql: string): Promise<T[]>
  exec(sql: string): Promise<void>
  transaction(sql: string): Promise<void>
  dump(file: string): Promise<void>
  close(): Promise<void>
}

export type Connection
  = { mode: 'docker', container: string, user: string, database: string, label: string }
    | { mode: 'direct', url: string, label: string }

export interface Repair {
  phase: 'pre' | 'post'
  kind: 'delete' | 'update'
  table: string
  where: string
  set?: string
  reason: string
}

export interface DroppedColumn {
  name: string
  type: string
  default: string | null
}

export interface Inventory {
  diff: Diff
  droppedTables: string[]
  droppedColumns: Map<string, DroppedColumn[]>
  repairs: Repair[]
}

export interface Images {
  node: string
  postgres: string
}

export interface MigrationConfig {
  disallowExternalApRedirect: boolean
  proxyRemoteFiles: boolean
  signToActivityPubGet: boolean
}

export interface ForkInfo {
  name: string
  version: string
  sha: string
  rev: string
  label: string
  id: string
}

export interface BundleMeta {
  generatedAt: string
  command: string
  fork: ForkInfo & { repository: string, cacheDir: string }
  base: { tag: string, sha: string, method: string, notes: string[], cacheDir: string }
  images: Images
  config: MigrationConfig
  passwordVerifiers: string[] | null
  warnings: string[]
}

export interface Bundle {
  dir: string
  meta: BundleMeta
  source: Snapshot
  target: Snapshot
  sql: string
  label: string
}

export interface Variant {
  id: string
  repoDir: string
  sha: string
  ref: Ref
}
