import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Args } from './args.ts'
import type { Connection } from './types.ts'

interface InstanceDb {
  host: string
  port: number
  db: string
  user: string
  pass: string
}

function fromInstanceConfig(file: string): InstanceDb {
  const cfg = yaml.load(readFileSync(file, 'utf8')) as { db?: Partial<InstanceDb> } | null
  if (!cfg?.db) throw new Error(`${file} has no "db" section`)
  const { host = 'localhost', port = 5432, db = '', user = '', pass = '' } = cfg.db
  return { host, port, db, user, pass }
}

const redact = (url: string): string => url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@')

export const hasConnection = (args: Args): boolean => args.has('config') || args.has('db') || args.has('docker')

export function resolveConnection(args: Args): Connection {
  const container = args.get('docker')
  const config = args.get('config')
  if (container) {
    let user = args.get('user') ?? process.env.POSTGRES_USER
    let database = args.get('database') ?? process.env.POSTGRES_DB
    if ((!user || !database) && config) {
      const c = fromInstanceConfig(config)
      user ??= c.user
      database ??= c.db
    }
    if (!user || !database) throw new Error('--docker needs --user and --database, or --config <default.yml> to read them from')
    return { mode: 'docker', container, user, database, label: `docker container ${container} (db ${database})` }
  }

  const url = args.get('db')
  if (url) return { mode: 'direct', url, label: redact(url) }

  if (config) {
    const c = fromInstanceConfig(config)
    const host = args.get('host') ?? c.host
    const direct = `postgres://${encodeURIComponent(c.user)}:${encodeURIComponent(c.pass)}@${host}:${c.port}/${c.db}`
    return { mode: 'direct', url: direct, label: `${c.db} at ${host}:${c.port} (from ${path.basename(config)})` }
  }

  const fromEnv = process.env.UNFORK_DB_URL
  if (fromEnv) return { mode: 'direct', url: fromEnv, label: redact(fromEnv) }

  if (process.env.PGDATABASE) {
    const direct = `postgres://${process.env.PGUSER ?? 'postgres'}:${encodeURIComponent(process.env.PGPASSWORD ?? '')}@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? 5432}/${process.env.PGDATABASE}`
    return { mode: 'direct', url: direct, label: `${process.env.PGDATABASE} (from PG* environment)` }
  }

  throw new Error('no database given. Use --docker <container>, --db <url>, or --config <default.yml>.')
}

export function findInstanceConfig(cwd = process.cwd()): string | null {
  return [path.join(cwd, '.config', 'default.yml'), path.join(cwd, 'default.yml')].find(existsSync) ?? null
}
