#!/usr/bin/env node
// Runs the revert against a real pg_dump of a fork instance, restored into a
// throwaway container. The fork revision is matched from the dump's own
// migrations table unless --rev is given.
//
// Usage: node test/dump.ts <file.dump> --fork <repository> [--rev <ref>] [--base <tag>]
//                          [--misskey <url|path>] [--postgres-image <image>] [--keep]

import { mkdtempSync, rmSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Args } from '../src/args.ts'
import { loadBundle } from '../src/bundle.ts'
import { psql, startPostgres, stopPostgres } from '../src/docker.ts'
import { cli, indent, passthrough, revertAndJudge, summary } from './lib.ts'

const args = Args.parse(process.argv.slice(2))
const dump = args.positional[0] ?? ''
const fork = args.get('fork') ?? ''
if (!dump || !fork) {
  console.error('usage: node test/dump.ts <file.dump> --fork <repository> [--rev <ref>] [--base <tag>] [--misskey <url|path>] [--postgres-image <image>] [--keep]')
  process.exit(1)
}

const PG = { container: 'unfork-dump-pg', network: 'unfork-dump-net', image: args.get('postgres-image') ?? 'postgres:15-alpine' }
const DB = 'sample'

// Schema first, then data with constraint triggers off: a live instance can
// hold rows that violate its own foreign keys, and the test wants that
// database as it is, not one with the constraint missing.
function restore(file: string): string {
  const run = (extra: string[]): string => {
    const r = spawnSync('docker', ['exec', '-i', PG.container, 'pg_restore', '-U', 'postgres', '-d', DB, '--no-owner', '--no-acl', ...extra],
      { stdio: [openSync(file, 'r'), 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.error) throw r.error
    return r.stderr.trim()
  }
  return [run(['--section=pre-data', '--section=post-data']), run(['--section=data', '--disable-triggers'])].filter(Boolean).join('\n')
}

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), 'unfork-dump-'))
  const bundleDir = path.join(work, 'bundle')

  await startPostgres({ ...PG, publishPort: 55434 })
  try {
    console.log(`[restoring ${path.basename(dump)}]`)
    psql(PG.container, 'postgres', `CREATE DATABASE ${DB};\n`)
    const warnings = restore(dump)
    const restoreErrors = (warnings.match(/^pg_restore: error/gm) ?? []).length
    if (warnings) console.log(indent(warnings.split('\n').slice(0, 8).join('\n')))
    if (restoreErrors) console.log(indent(`${restoreErrors} restore error(s); objects that failed are missing, so the plan will report drift`))

    console.log('\n[generate]')
    const gen = cli(['generate', fork, '--out', bundleDir, '--docker', PG.container, '--user', 'postgres', '--database', DB,
      ...passthrough('rev', args.get('rev')), ...passthrough('base', args.get('base')), ...passthrough('misskey', args.get('misskey'))])
    process.stdout.write(indent(gen.stdout) + '\n')
    if (gen.status !== 0) {
      console.error(gen.stderr)
      process.exit(1)
    }
    const bundle = loadBundle(bundleDir)

    await revertAndJudge({ pg: PG, db: DB, work, bundle, bundleDir, backupDir: path.join(work, 'backup'), expectDrift: restoreErrors > 0 })
  }
  finally {
    if (args.has('keep')) {
      console.log(`\nkept: container ${PG.container} (port 55434), workdir ${work}`)
    }
    else {
      stopPostgres(PG)
      rmSync(work, { recursive: true, force: true })
    }
  }
  process.exit(summary())
}

await main()
