export function assert(value: any, message: string = 'assertion failed'): asserts value {
  if (!value) throw new Error(message)
}

export function getEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

export function getBookId(): string {
  const id = process.env.BOOK_ID || process.env.IA_ID || process.env.ASIN
  if (!id) throw new Error('BOOK_ID or IA_ID (or ASIN) is required')
  return id
}

