#!/usr/bin/env node
// Usage: node test/e2e.ts <repository> [--rev <ref>] [--base <tag>] [--misskey <url|path>]
//                         [--fixtures <file.sql>] [--keep]

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Args } from '../src/args.ts'
import { loadBundle } from '../src/bundle.ts'
import { applyMigrations } from '../src/reference.ts'
import { psql, startPostgres, stopPostgres } from '../src/docker.ts'
import { cli, indent, passthrough, revertAndJudge, summary } from './lib.ts'

const args = Args.parse(process.argv.slice(2))
const repository = args.positional[0]
if (!repository) {
  console.error('usage: node test/e2e.ts <repository> [--rev <ref>] [--base <tag>] [--misskey <url|path>] [--fixtures <file.sql>] [--keep]')
  process.exit(1)
}

const PG = { container: 'unfork-e2e-pg', network: 'unfork-e2e-net' }
const DB = 'e2e'

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), 'unfork-e2e-'))
  const bundleDir = path.join(work, 'bundle')

  console.log('[generate]')
  const gen = cli(['generate', repository, '--out', bundleDir,
    ...passthrough('rev', args.get('rev')), ...passthrough('base', args.get('base')), ...passthrough('misskey', args.get('misskey'))])
  process.stdout.write(indent(gen.stdout) + '\n')
  if (gen.status !== 0) {
    console.error(gen.stderr)
    process.exit(1)
  }
  const bundle = loadBundle(bundleDir)
  const { meta } = bundle

  await startPostgres({ ...PG, image: meta.images.postgres, publishPort: 55433 })
  try {
    console.log(`\n[building a ${bundle.source.ref.label} database]`)
    psql(PG.container, 'postgres', `DROP DATABASE IF EXISTS ${DB};\nCREATE DATABASE ${DB};\n`)
    const output = await applyMigrations(work, { id: meta.fork.id, repoDir: meta.fork.cacheDir, sha: meta.fork.sha, ref: bundle.source.ref },
      { images: meta.images, config: meta.config, network: PG.network, container: PG.container, database: DB })
    console.log(indent(output.split('\n').slice(-2).join('\n')))
    const fixtures = args.get('fixtures')
    if (fixtures) psql(PG.container, DB, readFileSync(fixtures, 'utf8'))

    await revertAndJudge({ pg: PG, db: DB, work, bundle, bundleDir, backupDir: path.join(work, 'backup') })
  }
  finally {
    if (args.has('keep')) {
      console.log(`\nkept: container ${PG.container} (port 55433), workdir ${work}`)
    }
    else {
      stopPostgres(PG)
      rmSync(work, { recursive: true, force: true })
    }
  }
  process.exit(summary())
}

await main()
