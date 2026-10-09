import { readFileAt } from './repos.ts'
import type { Db } from './types.ts'

const SIGNIN = 'packages/backend/src/server/api/SigninApiService.ts'

const VERIFIERS: Record<string, RegExp> = { bcrypt: /bcrypt\.compare/, argon2: /argon2\.verify/ }
const SCHEMES: Record<string, string> = { '2a': 'bcrypt', '2b': 'bcrypt', '2y': 'bcrypt', 'argon2id': 'argon2', 'argon2i': 'argon2', 'argon2d': 'argon2' }

export interface PasswordScheme {
  scheme: string
  algorithm: string | null
  accounts: number
  verifiable: boolean | null
}

export function passwordVerifiers(repoDir: string, rev: string): string[] | null {
  const source = readFileAt(repoDir, rev, SIGNIN)
  if (source === null) return null
  return Object.keys(VERIFIERS).filter(name => VERIFIERS[name].test(source))
}

export async function checkPasswords(db: Db, verifiers: string[] | null): Promise<PasswordScheme[]> {
  const rows = await db.query<{ scheme: string | null, n: string | number }>(`
    SELECT substring(p."password" from '^\\$([A-Za-z0-9]+)\\$') AS scheme, count(*)::bigint AS n
    FROM "user_profile" p JOIN "user" u ON u."id" = p."userId"
    WHERE u."host" IS NULL AND p."password" IS NOT NULL AND p."password" <> ''
    GROUP BY 1 ORDER BY 2 DESC`)
  return rows.map((r) => {
    const algorithm = (r.scheme && SCHEMES[r.scheme]) ?? null
    return {
      scheme: r.scheme ?? '(none)',
      algorithm,
      accounts: Number(r.n),
      verifiable: verifiers && algorithm ? verifiers.includes(algorithm) : verifiers ? false : null,
    }
  })
}
