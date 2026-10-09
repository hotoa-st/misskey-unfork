import { git, listTree } from './repos.ts'
import { MIGRATIONS_DIR } from './base.ts'
import type { Migration } from './types.ts'

export interface RevisionMatch {
  rev: string
  how: string
  unapplied: number
  historical: number
  newestFile: number
  isKnown: (m: Migration) => boolean
}

interface Candidate {
  rev: string
  how: string
}

const fileTimestamp = (f: string): string | undefined => /^(\d+)-.*\.js$/.exec(f)?.[1]
const fileSlug = (f: string): string | undefined => /^\d+-(.*)\.js$/.exec(f)?.[1].replace(/[-_]/g, '').toLowerCase()
const nameSlug = (n: string): string => n.replace(/\d+$/, '').replace(/[-_]/g, '').toLowerCase()

export const migrationTimestamps = (migrations: Migration[]): Set<string> => new Set(migrations.map(m => String(m.timestamp)))

function branches(dir: string): string[] {
  const refs = git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin', 'refs/heads']).stdout.split('\n').filter(Boolean)
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { check: false }).stdout.trim()
  const named = refs.filter(r => /^(origin\/)?(develop|main|master)$/.test(r))
  return [...new Set([head, ...named].filter(Boolean))]
}

// Along a branch the applied set only grows, so the right revision is where
// "applied files minus unapplied files" peaks. A few upstream files carry a
// different timestamp in their class name than in their file name and count
// as unapplied everywhere, which cancels out. Rows for files deleted since
// count for nothing.
export function matchRevision(dir: string, applied: Set<string>): RevisionMatch | null {
  const candidates: Candidate[] = git(dir, ['tag', '--sort=-creatordate']).stdout.split('\n').filter(Boolean).map(rev => ({ rev, how: 'tag' }))
  for (const branch of branches(dir)) {
    const commits = git(dir, ['log', '--first-parent', '--format=%H', branch, '--', MIGRATIONS_DIR]).stdout.split('\n').filter(Boolean)
    candidates.push(...commits.map(rev => ({ rev, how: `commit on ${branch}` })))
  }

  let best: (Candidate & { files: Set<string>, unapplied: number, score: number }) | null = null
  const knownTimestamps = new Set<string>()
  const knownSlugs = new Set<string>()
  for (const candidate of candidates) {
    const names = listTree(dir, candidate.rev, MIGRATIONS_DIR)
    for (const f of names) {
      const ts = fileTimestamp(f)
      const slug = fileSlug(f)
      if (ts && slug) {
        knownTimestamps.add(ts)
        knownSlugs.add(slug)
      }
    }
    const files = new Set(names.map(fileTimestamp).filter((t): t is string => t !== undefined))
    if (files.size === 0) continue
    const unapplied = [...files].filter(t => !applied.has(t)).length
    const score = (files.size - unapplied) - unapplied
    if (!best || score > best.score) best = { ...candidate, files, unapplied, score }
  }
  if (!best) return null
  const files = best.files
  return {
    rev: best.rev,
    how: best.how,
    unapplied: best.unapplied,
    historical: [...applied].filter(t => !files.has(t)).length,
    newestFile: Math.max(...[...files].map(Number)),
    isKnown: m => knownTimestamps.has(String(m.timestamp)) || knownSlugs.has(nameSlug(m.name)),
  }
}
