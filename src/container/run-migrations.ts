import { DataSource } from 'typeorm'
import pg from 'pg'
import { writeFileSync } from 'node:fs'
import { snapshot, readMigrations } from './schema.ts'
import type { Row } from './types.ts'

const arg = (name: string): string => process.argv[process.argv.indexOf(`--${name}`) + 1]

const url = arg('db')
const ds = new DataSource({
  type: 'postgres',
  url,
  migrations: [`${arg('migrations')}/*.js`],
  migrationsTransactionMode: 'all',
})

await ds.initialize()
const ran = await ds.runMigrations({ transaction: 'all' })
console.log(`applied ${ran.length} migrations`)
await ds.destroy()

const client = new pg.Client({ connectionString: url })
await client.connect()
const db = { query: async <T extends Row>(sql: string): Promise<T[]> => (await client.query<T>(sql)).rows }
const out = { schema: await snapshot(db), migrations: await readMigrations(db) }
await client.end()

writeFileSync(arg('out'), JSON.stringify(out, null, '\t'))
console.log(`wrote ${arg('out')} (${out.migrations.length} migration rows)`)
