const RELEASE_TAG = /^(\d{4})\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/

export const isReleaseTag = (tag: string): boolean => RELEASE_TAG.test(tag)
export const isStableTag = (tag: string): boolean => isReleaseTag(tag) && !tag.includes('-')

export function compareVersions(a: string, b: string): number {
  const [, ay, am, ap, apre, apren] = RELEASE_TAG.exec(a) ?? []
  const [, by, bm, bp, bpre, bpren] = RELEASE_TAG.exec(b) ?? []
  for (const [x, y] of [[ay, by], [am, bm], [ap, bp]]) {
    if (Number(x) !== Number(y)) return Number(x) - Number(y)
  }
  if (!apre && !bpre) return 0
  if (!apre) return 1
  if (!bpre) return -1
  if (apre !== bpre) return apre < bpre ? -1 : 1
  return Number(apren) - Number(bpren)
}

export const newest = (tags: string[]): string | null => [...tags].sort(compareVersions).at(-1) ?? null
