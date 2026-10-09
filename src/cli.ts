#!/usr/bin/env node
import path from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { Args } from './args.ts'
import { cacheRepo, describeFork, resolveRev, DEFAULT_MISSKEY } from './repos.ts'
import { findBase } from './base.ts'
import { imagesFor, buildSnapshots, configFromFile, configFromDatabase, postgresImageOf, DEFAULT_CONFIG } from './reference.ts'
import { generateRevert } from './revert.ts'
import { passwordVerifiers } from './login.ts'
import { GENERATED, writeBundle, loadBundle, findBundle, readExtraSql, hasSnapshots } from './bundle.ts'
import { resolveConnection, findInstanceConfig, hasConnection } from './connection.ts'
import { openDb } from './db.ts'
import { collectPlan, formatPlan } from './plan.ts'
import { runBackup, readManifest } from './backup.ts'
import { verify, formatVerify } from './verify.ts'
import { readMigrations } from './schema.ts'
import { matchRevision, migrationTimestamps } from './match.ts'
import type { Bundle, Connection, Db, Snapshot, Variant } from './types.ts'

const USAGE = `
unfork - return a forked Misskey database to the Misskey release it was built on

Usage
  unfork generate <repository> [options]
  unfork plan | backup | apply | verify [--bundle <dir>] <connection>

generate
  <repository>           Git URL or local path of the fork.
  --rev <ref>            Fork revision the instance runs. Default: HEAD, or, when a
                         connection is given, the revision whose migrations match
                         the database's migrations table.
  --base <tag>           Misskey release to return to. Default: detected.
  --misskey <url|path>   Misskey repository. Default: ${DEFAULT_MISSKEY}
  --out <dir>            Output directory. Default: generated/<fork>-to-misskey-<tag>
  --reuse                Regenerate revert.sql from the snapshots already in --out.
  --postgres-image <i>   Postgres image for the snapshots. Default: the database's
                         major when a connection is given, else compose_example.yml.

  With a connection, generate also reads the default.yml values some migrations
  bake into the schema from the database (or from --config when given).

  Writes source.json and target.json (the schema each revision's migrations
  produce), revert.sql, and bundle.json. A pre.sql or post.sql placed in the
  output directory is spliced into revert.sql on the next generate.

plan      Show what would change and what data would be lost. Read-only.
backup    pg_dump the database and extract the data the revert removes.
apply     Run revert.sql in one transaction, then verify. Requires a backup.
verify    Compare the database with the target release. Read-only.

Connection (pick one)
  --docker <container>   Run psql and pg_dump inside the Postgres container.
                         Needs --user and --database, or --config.
  --db <url>             postgres://user:pass@host:port/database
  --config <file>        The instance's .config/default.yml. --host overrides the host.
  Otherwise UNFORK_DB_URL or the PG* variables are used.

Options
  --backup-dir <dir>     Default: ./backup/<timestamp> for backup, the newest for apply.
  --yes                  Skip the confirmation prompt on apply.
  --skip-extracts        backup: write only the pg_dump.
  --allow-drift          apply even though the database differs from the fork schema.
`.trim()

const newestDir = (root: string): string | null => {
  if (!existsSync(root)) return null
  return readdirSync(root).map(d => path.join(root, d)).filter(d => statSync(d).isDirectory()).sort().pop() ?? null
}

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [type "yes" to continue] `)
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(c as Buffer)
    if (Buffer.concat(chunks).includes('\n')) break
  }
  return Buffer.concat(chunks).toString().trim() === 'yes'
}

async function withDatabase<T>(args: Args, fn: (db: Db, conn: Connection) => Promise<T>): Promise<T> {
  if (!hasConnection(args)) {
    const found = findInstanceConfig()
    if (found) {
      args.set('config', found)
      console.log(`using instance config ${found}`)
    }
  }
  const conn = resolveConnection(args)
  const db = openDb(conn)
  try {
    return await fn(db, conn)
  }
  finally {
    await db.close()
  }
}

async function generate(args: Args): Promise<void> {
  const spec = args.positional[1]
  if (!spec) throw new Error('generate needs a repository URL or path')
  const forkDir = cacheRepo(spec)
  const configFile = args.get('config')
  let rev = args.get('rev')
  let config = configFile ? configFromFile(configFile) : DEFAULT_CONFIG
  let postgresImage = args.get('postgres-image')
  if (hasConnection(args)) {
    await withDatabase(args, async (db) => {
      if (!configFile) config = await configFromDatabase(db)
      postgresImage ??= await postgresImageOf(db)
      if (rev) return
      const migrations = await readMigrations(db)
      const match = matchRevision(forkDir, migrationTimestamps(migrations))
      if (!match) throw new Error('no tag or branch commit of the fork matches the migration set this database has; pass --rev')
      rev = match.rev
      const detail = [match.how, 'matched to the migrations table']
      if (match.unapplied) detail.push(`${match.unapplied} file(s) not in the table`)
      if (match.historical) detail.push(`${match.historical} row(s) with no file`)
      console.log(`rev:   ${rev}  (${detail.join(', ')})`)
      const unknown = migrations.filter(m => !match.isKnown(m))
      const newer = unknown.filter(m => m.timestamp > match.newestFile)
      const older = unknown.filter(m => !newer.includes(m))
      if (newer.length) {
        console.log(`note:  ${newer.length} applied migration(s) newer than ${rev} exist in no revision of this repository: ${newer.map(m => m.name).join(', ')}`)
        console.log('       the instance runs code this repository does not have; point generate at the repository it was built from')
      }
      if (older.length) {
        console.log(`note:  ${older.length} older applied migration(s) are unknown to this repository and left no trace in the schema check: ${older.map(m => m.name).join(', ')}`)
      }
    })
  }
  rev ??= 'HEAD'
  const fork = describeFork(forkDir, rev)
  const misskeyDir = cacheRepo(args.get('misskey') ?? DEFAULT_MISSKEY)
  const base = findBase({ misskey: misskeyDir, fork: forkDir, forkSha: fork.sha, override: args.get('base') })

  console.log(`\nfork:  ${fork.label}  (${rev} = ${fork.sha.slice(0, 10)})`)
  console.log(`base:  Misskey ${base.tag}  (by ${base.method})`)
  for (const n of base.notes) console.log(`note:  ${n}`)
  const configSource = configFile ? 'from --config' : hasConnection(args) ? 'read from the database' : 'defaults'
  console.log(`config: ${Object.entries(config).map(([k, v]) => `${k}=${v}`).join(' ')}  (${configSource})`)

  const out = path.resolve(args.get('out') ?? path.join(GENERATED, `${fork.id}-to-misskey-${base.tag}`))
  const images = imagesFor(misskeyDir, base.tag, postgresImage)
  const imageSource = args.has('postgres-image') ? 'given' : postgresImage ? 'the database server\'s major' : 'from compose_example.yml'
  console.log(`images: ${images.postgres} (${imageSource}), ${images.node}`)
  const baseSha = resolveRev(misskeyDir, base.tag)

  let source: Snapshot
  let target: Snapshot
  if (args.has('reuse')) {
    if (!hasSnapshots(out)) throw new Error(`--reuse: no snapshots in ${out}`)
    ;({ source, target } = loadBundle(out))
  }
  else {
    const variants: Variant[] = [
      { id: `misskey-${base.tag}`, repoDir: misskeyDir, sha: baseSha, ref: { label: `Misskey ${base.tag}`, rev: base.tag, sha: baseSha } },
      { id: fork.id, repoDir: forkDir, sha: fork.sha, ref: { label: fork.label, rev, sha: fork.sha, repository: spec } },
    ]
    const snapshots = await buildSnapshots(variants, images, config)
    target = snapshots[variants[0].id]
    source = snapshots[variants[1].id]
  }

  const misskeyArg = args.get('misskey')
  const command = `unfork generate ${spec} --rev ${rev} --base ${base.tag}${misskeyArg ? ` --misskey ${misskeyArg}` : ''}`
  const { sql, warnings, diff } = generateRevert(source, target, {
    pre: readExtraSql(out, 'pre'),
    post: readExtraSql(out, 'post'),
    regenerate: command,
  })

  writeBundle(out, {
    meta: {
      generatedAt: new Date().toISOString(),
      command,
      fork: { ...fork, repository: spec, cacheDir: forkDir },
      base: { tag: base.tag, sha: baseSha, method: base.method, notes: base.notes, cacheDir: misskeyDir },
      images,
      config,
      passwordVerifiers: passwordVerifiers(misskeyDir, base.tag),
      warnings,
    },
    source,
    target,
    sql,
  })

  console.log(`\nwrote ${out}`)
  console.log(`  revert.sql covers ${diff.count} schema difference(s):`)
  for (const [name, d] of Object.entries(diff.sections)) {
    console.log(`    ${name}: ${d.onlyA.length} to remove, ${d.onlyB.length} to add, ${d.changed.length} to alter`)
  }
  if (warnings.length) {
    console.log('\nwarnings:')
    for (const w of warnings) console.log(`  ${w}`)
  }
  console.log(`\nnext: unfork plan --bundle ${out} <connection>`)
}

async function apply(args: Args, db: Db, conn: Connection, bundle: Bundle): Promise<void> {
  const root = args.get('backup-dir') ?? 'backup'
  const dir = args.get('backup-dir') ?? newestDir(root)
  const manifest = dir ? readManifest(dir) : null
  if (!dir || !manifest) {
    throw new Error(`no backup found${dir ? ` in ${path.resolve(dir)}` : ` under ${path.resolve(root)}`}. Run \`unfork backup\` first; apply drops tables and columns and cannot undo itself.`)
  }
  console.log(`database: ${conn.label}`)
  console.log(`bundle:   ${bundle.dir}`)
  console.log(`backup:   ${path.resolve(dir)}  (taken ${manifest.createdAt})\n`)

  const plan = await collectPlan(db, bundle)
  console.log(formatPlan(plan), '')

  if (plan.drift.count > 0 && !args.has('allow-drift')) {
    throw new Error(`refusing to apply: this database differs from ${bundle.source.ref.label} in ${plan.drift.count} place(s). Read the differences above; if they are expected, re-run with --allow-drift.`)
  }
  if (!args.has('yes') && !await confirm('Apply the revert? The instance must be stopped.')) {
    console.log('aborted.')
    process.exit(1)
  }

  process.stdout.write('applying revert.sql in one transaction ... ')
  await db.transaction(bundle.sql)
  console.log('committed.\n')

  const result = await verify(db, bundle)
  console.log(formatVerify(result))
  if (!result.ok) process.exit(2)
}

async function backup(args: Args, db: Db, conn: Connection, bundle: Bundle): Promise<void> {
  const dir = args.get('backup-dir') ?? path.join('backup', new Date().toISOString().replace(/[:.]/g, '-'))
  console.log(`database: ${conn.label}\nbacking up to ${path.resolve(dir)}\n`)
  const manifest = await runBackup(db, dir, bundle, { label: conn.label, extracts: !args.has('skip-extracts') })
  const dump = path.join(dir, 'full.dump')
  console.log(`\ndone. ${manifest.extracts.length} extract file(s) beside the full dump.`)
  console.log('restore the whole database with:')
  console.log(conn.mode === 'docker'
    ? `  docker exec -i ${conn.container} pg_restore -U ${conn.user} -d ${conn.database} --clean --if-exists < ${dump}`
    : `  pg_restore --clean --if-exists -d <database> ${dump}`)
}

async function main(): Promise<void> {
  const args = Args.parse(process.argv.slice(2))
  const command = args.positional[0]
  if (!command || args.has('help')) {
    console.log(USAGE)
    process.exit(args.has('help') ? 0 : 1)
  }

  if (command === 'generate') return generate(args)
  if (!['plan', 'backup', 'apply', 'verify'].includes(command)) {
    console.error(`unknown command: ${command}\n\n${USAGE}`)
    process.exit(1)
  }

  const bundle = loadBundle(findBundle(args.get('bundle')))
  await withDatabase(args, async (db, conn) => {
    switch (command) {
      case 'plan':
        console.log(`database: ${conn.label}\nbundle:   ${bundle.dir}\n`)
        console.log(formatPlan(await collectPlan(db, bundle)))
        break

      case 'backup':
        await backup(args, db, conn, bundle)
        break

      case 'apply':
        await apply(args, db, conn, bundle)
        break

      case 'verify': {
        console.log(`database: ${conn.label}\nbundle:   ${bundle.dir}\n`)
        const result = await verify(db, bundle)
        console.log(formatVerify(result))
        if (!result.ok) process.exit(2)
      }
    }
  })
}

main().catch((e: unknown) => {
  console.error(`\nerror: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
