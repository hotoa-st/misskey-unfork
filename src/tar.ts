import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Parsed in-process: on Windows, GNU tar reads a `D:\...` argument as a remote
// host and bsdtar disagrees on the flag that turns that off.

const field = (buf: Buffer, off: number, len: number): string => {
  const end = buf.indexOf(0, off)
  return buf.toString('utf8', off, end === -1 || end > off + len ? off + len : end)
}

export function extractTar(buf: Buffer, dest: string, { strip = 0 } = {}): string[] {
  const written: string[] = []
  let longName: string | null = null

  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512)
    if (header.every(b => b === 0)) break

    const rawName = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const size = parseInt(field(header, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156]) || '0'
    const body = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '')
      continue
    }

    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
    longName = null

    const parts = name.split('/').filter(Boolean).slice(strip)
    if (parts.length === 0) continue
    const rel = parts.join('/')
    const abs = path.join(dest, rel)

    if (type === '5' || name.endsWith('/')) {
      mkdirSync(abs, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\0') continue

    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body)
    written.push(rel)
  }
  return written
}
