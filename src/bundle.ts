import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './repos.ts'
import type { Bundle, BundleMeta, Snapshot } from './types.ts'

export const GENERATED = path.join(ROOT, 'generated')

const FILES = { meta: 'bundle.json', source: 'source.json', target: 'target.json', sql: 'revert.sql' } as const

export function writeBundle(dir: string, { meta, source, target, sql }: { meta: BundleMeta, source: Snapshot, target: Snapshot, sql: string }): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta, null, '\t') + '\n')
  writeFileSync(path.join(dir, FILES.source), JSON.stringify(source, null, '\t') + '\n')
  writeFileSync(path.join(dir, FILES.target), JSON.stringify(target, null, '\t') + '\n')
  writeFileSync(path.join(dir, FILES.sql), sql)
}

export const readExtraSql = (dir: string, name: 'pre' | 'post'): string => {
  const file = path.join(dir, `${name}.sql`)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export const hasSnapshots = (dir: string): boolean => existsSync(path.join(dir, FILES.source))

export function loadBundle(dir: string): Bundle {
  const read = (name: keyof typeof FILES): string => readFileSync(path.join(dir, FILES[name]), 'utf8')
  const source = JSON.parse(read('source')) as Snapshot
  const target = JSON.parse(read('target')) as Snapshot
  return {
    dir,
    meta: JSON.parse(read('meta')) as BundleMeta,
    source,
    target,
    sql: read('sql'),
    label: `${source.ref.label} -> ${target.ref.label}`,
  }
}

export function findBundle(explicit: string | undefined): string {
  if (explicit) return path.resolve(explicit)
  const dirs = existsSync(GENERATED)
    ? readdirSync(GENERATED).map(d => path.join(GENERATED, d)).filter(d => statSync(d).isDirectory() && existsSync(path.join(d, FILES.meta)))
    : []
  if (dirs.length === 1) return dirs[0]
  if (dirs.length === 0) throw new Error('no generated bundle found; run `unfork generate <repository>` first')
  throw new Error(`several bundles under generated/; pick one with --bundle:\n${dirs.map(d => `  ${d}`).join('\n')}`)
}
