import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { assert, getBookId } from './utils'

async function main() {
  const bookId = getBookId()
  const outDir = path.join('out', bookId)

  const content = JSON.parse(
    await fs.readFile(path.join(outDir, 'content.json'), 'utf8')
  ) as ContentChunk[]
  assert(content.length, 'no book content found')

  // Try to load metadata; if missing (e.g., capture was stopped), synthesize a minimal one
  let metadata: BookMetadata | undefined
  try {
    metadata = JSON.parse(
      await fs.readFile(path.join(outDir, 'metadata.json'), 'utf8')
    ) as BookMetadata
  } catch {}

  if (!metadata?.meta || !metadata?.toc?.length) {
    const maxPage = content.reduce((m, c) => Math.max(m, c.page || 0), 0) || 0
    metadata = {
      info: {},
      meta: {
        asin: bookId,
        title: bookId,
        authorList: ['Unknown']
      },
      toc: [
        { title: 'Content', page: 1, total: maxPage || content.length },
        { title: 'End', page: maxPage || content.length, total: maxPage || content.length }
      ],
      pages: [] as any
    } as BookMetadata
    // Best-effort: write the synthesized metadata so later steps have it
    try {
      await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
    } catch {}
  }

  // Ensure content is ordered by capture index, then page number if present
  const contentSorted = [...content].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index
    const ap = a.page ?? Number.MAX_SAFE_INTEGER
    const bp = b.page ?? Number.MAX_SAFE_INTEGER
    return ap - bp
  })

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  function computeNextIndex(currentIndex: number, tocIndex: number) {
    const tocItem = metadata.toc[tocIndex]!
    const nextTocItem = metadata.toc[tocIndex + 1]!
    if (!nextTocItem) return contentSorted.length
    if (nextTocItem.page === undefined) return contentSorted.length
    let nextIndex = contentSorted.findIndex((c) => c.page >= nextTocItem.page!)
    if (nextIndex === -1) nextIndex = contentSorted.length
    // Ensure monotonic progression
    if (nextIndex < currentIndex) nextIndex = currentIndex
    return nextIndex
  }

  let lastTocItemIndex = 0
  for (let i = 0, index = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue
    const nextIndex = computeNextIndex(index, i)
    lastTocItemIndex = i
  }

  let output = `# ${title}\n\nBy ${authors.join(', ')}\n\n---\n\n## Table of Contents\n\n${metadata.toc
    .filter((tocItem: import('./types').TocItem, index: number) => tocItem.page !== undefined && index <= lastTocItemIndex)
    .map((tocItem: import('./types').TocItem) => `- [${tocItem.title}](#${tocItem.title.toLowerCase().replaceAll(/[^\da-z]+/g, '-')})`)
    .join('\n')}\n\n---`

  for (let i = 0, index = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextIndex = computeNextIndex(index, i)

    const chunks = contentSorted.slice(index, nextIndex)

    const text = chunks
      .map((chunk) =>
        chunk.text
          .replace(/\r/g, '')
          // preserve paragraph breaks, fold single newlines into spaces
          .replace(/\n{2,}/g, '\n\n')
          .replace(/\n/g, ' ')
          .trim()
      )
      .join('\n\n')

    output += `\n\n## ${tocItem.title}\n\n${text}`

    index = nextIndex
  }

  await fs.writeFile(path.join(outDir, 'book.md'), output)
  console.log(output)
}

await main()
