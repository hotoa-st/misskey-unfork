export class Args {
  positional: string[] = []
  private values = new Map<string, string | true>()

  static parse(argv: string[]): Args {
    const args = new Args()
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      if (!a.startsWith('--')) {
        args.positional.push(a)
        continue
      }
      const [key, inline] = a.slice(2).split(/=(.*)/s)
      const next = argv[i + 1]
      if (inline !== undefined) {
        args.values.set(key, inline)
      }
      else if (next !== undefined && !next.startsWith('--')) {
        args.values.set(key, next)
        i++
      }
      else {
        args.values.set(key, true)
      }
    }
    return args
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  get(name: string): string | undefined {
    const v = this.values.get(name)
    return typeof v === 'string' ? v : undefined
  }

  set(name: string, value: string): void {
    this.values.set(name, value)
  }
}
