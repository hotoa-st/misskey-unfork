import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { extractTar } from './tar.ts'
import type { ForkInfo } from './types.ts'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.cache')

export const DEFAULT_MISSKEY = 'https://github.com/misskey-dev/misskey.git'

const isUrl = (spec: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(spec) || /^[^/\\]+@[^/\\]+:/.test(spec)

export function git(dir: string, args: string[], { check = true } = {}): SpawnSyncReturns<string> {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw r.error
  if (check && r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}:\n${r.stderr}`)
  return r
}

function gitBuffer(dir: string, args: string[]): Buffer {
  const r = spawnSync('git', ['-C', dir, ...args], { maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}:\n${r.stderr.toString()}`)
  return r.stdout
}

function cacheName(spec: string): string {
  const base = isUrl(spec) ? spec.replace(/\/+$/, '').split(/[/:]/).pop() ?? spec : path.basename(path.resolve(spec))
  const origin = isUrl(spec) ? spec : path.resolve(spec)
  return `${base.replace(/\.git$/, '').replace(/[^\w.-]/g, '_')}-${createHash('sha1').update(origin).digest('hex').slice(0, 8)}`
}

export function cacheRepo(spec: string, { quiet = false } = {}): string {
  mkdirSync(CACHE, { recursive: true })
  const dir = path.join(CACHE, cacheName(spec))
  const log = (m: string): void => {
    if (!quiet) console.log(m)
  }

  if (existsSync(path.join(dir, '.git'))) {
    log(`updating ${dir}`)
    git(dir, ['fetch', '--quiet', '--tags', '--prune', 'origin'])
    return dir
  }

  if (isUrl(spec)) {
    log(`cloning ${spec} (commits and trees only)`)
    git(ROOT, ['clone', '--quiet', '--filter=blob:none', '--no-checkout', spec, dir])
  }
  else {
    const src = path.resolve(spec)
    if (!existsSync(path.join(src, '.git'))) throw new Error(`not a git repository: ${src}`)
    log(`cloning ${src}`)
    git(ROOT, ['clone', '--quiet', '--shared', '--no-checkout', src, dir])
  }
  return dir
}

export const resolveRev = (dir: string, rev: string): string => git(dir, ['rev-parse', '--verify', `${rev}^{commit}`]).stdout.trim()

export function readFileAt(dir: string, rev: string, file: string): string | null {
  const r = git(dir, ['show', `${rev}:${file}`], { check: false })
  return r.status === 0 ? r.stdout : null
}

export const listTree = (dir: string, rev: string, subdir: string): string[] =>
  git(dir, ['ls-tree', '--name-only', rev, `${subdir}/`]).stdout
    .split('\n').filter(Boolean).map(p => path.posix.basename(p))

export function exportTree(dir: string, rev: string, subdir: string, dest: string): string[] {
  const archive = gitBuffer(dir, ['archive', rev, subdir])
  mkdirSync(dest, { recursive: true })
  return extractTar(archive, dest, { strip: subdir.split('/').length })
}

export const ancestorsOf = (dir: string, commit: string): Set<string> =>
  new Set(git(dir, ['rev-list', commit]).stdout.split('\n').filter(Boolean))

export function tagCommits(dir: string): Map<string, string> {
  const lines = git(dir, ['for-each-ref', '--format=%(refname:short) %(objectname) %(*objectname)', 'refs/tags']).stdout
  return new Map(lines.split('\n').filter(Boolean).map((l) => {
    const [tag, object, peeled] = l.split(' ')
    return [tag, peeled || object]
  }))
}

export function describeFork(dir: string, rev: string): ForkInfo {
  const sha = resolveRev(dir, rev)
  const pkg = JSON.parse(readFileAt(dir, sha, 'package.json') ?? '{}') as { name?: string, version?: string }
  const name = (pkg.name ?? path.basename(dir).replace(/-[0-9a-f]{8}$/, '')).replace(/^@/, '').replace(/\//g, '-')
  const version = pkg.version ?? sha.slice(0, 10)
  return { name, version, sha, rev, label: `${name} ${version}`, id: `${name}-${version}`.replace(/[^\w.-]/g, '_') }
}
