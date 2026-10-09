import pg from 'pg'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { Connection, Db, Row } from './types.ts'

class DirectDb implements Db {
  private connected: pg.Client | null = null
  private url: string

  constructor(url: string) {
    this.url = url
  }

  private async client(): Promise<pg.Client> {
    if (!this.connected) {
      this.connected = new pg.Client({ connectionString: this.url })
      await this.connected.connect()
    }
    return this.connected
  }

  async query<T extends Row = Row>(sql: string): Promise<T[]> {
    return (await (await this.client()).query<T>(sql)).rows
  }

  async exec(sql: string): Promise<void> {
    await (await this.client()).query(sql)
  }

  async transaction(sql: string): Promise<void> {
    const c = await this.client()
    await c.query('BEGIN')
    try {
      await c.query(sql)
      await c.query('COMMIT')
    }
    catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  }

  async dump(file: string): Promise<void> {
    const r = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', file, this.url], { encoding: 'utf8' })
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error('pg_dump is not on PATH; install the postgresql client tools or use --docker <container>')
    }
    if (r.status !== 0) throw new Error(`pg_dump failed: ${r.stderr}`)
  }

  async close(): Promise<void> {
    if (this.connected) await this.connected.end()
  }
}

// Compose stacks rarely publish the Postgres port, so psql and pg_dump run inside the container.
class DockerDb implements Db {
  private container: string
  private user: string
  private database: string

  constructor(container: string, user: string, database: string) {
    this.container = container
    this.user = user
    this.database = database
  }

  private psqlArgs(extra: string[]): string[] {
    return ['exec', '-i', this.container, 'psql', '-U', this.user, '-d', this.database, '-v', 'ON_ERROR_STOP=1', ...extra]
  }

  private run(args: string[], input?: string): string {
    const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`${r.stderr || r.stdout}`.trim())
    return r.stdout
  }

  async query<T extends Row = Row>(sql: string): Promise<T[]> {
    const asJson = `SELECT coalesce(json_agg(row_to_json(_q)), '[]'::json)::text FROM (\n${sql.replace(/;\s*$/, '')}\n) _q;`
    return JSON.parse(this.run(this.psqlArgs(['-At', '-c', asJson])).trim() || '[]') as T[]
  }

  async exec(sql: string): Promise<void> {
    this.run(this.psqlArgs(['-q', '-f', '-']), sql)
  }

  async transaction(sql: string): Promise<void> {
    this.run(this.psqlArgs(['-q', '--single-transaction', '-f', '-']), sql)
  }

  async dump(file: string): Promise<void> {
    const p = spawn('docker', [
      'exec', '-i', this.container, 'pg_dump',
      '-U', this.user, '-d', this.database, '--format=custom', '--no-owner', '--no-acl',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let err = ''
    p.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    const exited = new Promise<void>((resolve, reject) => {
      p.on('error', reject)
      p.on('close', code => (code === 0 ? resolve() : reject(new Error(`pg_dump failed: ${err.trim()}`))))
    })
    await Promise.all([exited, pipeline(p.stdout, createWriteStream(file))])
  }

  async close(): Promise<void> {}
}

export const openDb = (conn: Connection): Db =>
  conn.mode === 'docker' ? new DockerDb(conn.container, conn.user, conn.database) : new DirectDb(conn.url)
