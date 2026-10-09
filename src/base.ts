import { ancestorsOf, tagCommits, listTree } from './repos.ts'
import { isReleaseTag, isStableTag, compareVersions, newest } from './versions.ts'

export const MIGRATIONS_DIR = 'packages/backend/migration'

interface Scored {
  tag: string
  present: number
  missing: string[]
}

export interface BaseMatch {
  tag: string
  method: string
  byAncestry: string | null
  byMigrations: string | null
  notes: string[]
}

const migrationFiles = (dir: string, rev: string): Set<string> =>
  new Set(listTree(dir, rev, MIGRATIONS_DIR).filter(f => /^\d+-.*\.js$/.test(f)))

const fit = (s: Scored): number => s.present - s.missing.length

function score(misskey: string, tag: string, forkFiles: Set<string>): Scored {
  const files = migrationFiles(misskey, tag)
  const missing = [...files].filter(f => !forkFiles.has(f))
  return { tag, present: files.size - missing.length, missing }
}

// The two caches never exchange objects: a blobless clone cannot serve a
// commit to another repository, so ancestry is decided by comparing commit ids.
export function findBase({ misskey, fork, forkSha, override }: { misskey: string, fork: string, forkSha: string, override?: string }): BaseMatch {
  const forkAncestors = ancestorsOf(fork, forkSha)
  const tags = tagCommits(misskey)
  const isAncestor = (tag: string): boolean => forkAncestors.has(tags.get(tag) ?? '')
  const byAncestry = newest([...tags.keys()].filter(isReleaseTag).filter(isAncestor))

  const forkFiles = migrationFiles(fork, forkSha)
  const scored = [...tags.keys()].filter(isStableTag)
    .map(tag => score(misskey, tag, forkFiles))
    .sort((a, b) => fit(a) - fit(b) || compareVersions(b.tag, a.tag))
  const best = scored.at(-1)
  const byMigrations = best?.tag ?? null

  const tag = override ?? byAncestry ?? byMigrations
  if (!tag) throw new Error('no Misskey release could be matched to this fork; pass --base <tag>')

  const notes: string[] = []
  if (override) {
    if (!tags.has(override)) throw new Error(`${override} is not a tag of the Misskey repository`)
    if (!isAncestor(override)) notes.push(`${override} is not an ancestor of the fork revision`)
  }
  else if (!byAncestry) {
    notes.push('no Misskey release tag is an ancestor of the fork revision; the base was chosen by comparing migration files')
  }

  const chosen = score(misskey, tag, forkFiles)
  if (chosen.missing.length) {
    notes.push(`the fork lacks ${chosen.missing.length} of ${tag}'s migration files: ${chosen.missing.join(', ')}`)
  }
  if (best && best.tag !== tag && fit(best) > fit(chosen)) {
    notes.push(`migration files match ${best.tag} better than ${tag}`)
  }

  const method = override ? 'given' : byAncestry ? 'git ancestry' : 'migration files'
  return { tag, method, byAncestry, byMigrations, notes }
}
