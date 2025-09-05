export interface ContentChunk {
  index: number
  page: number
  text: string
  screenshot: string
}

export interface TocItem {
  title: string
  page?: number
  location?: number
  total: number
}

export interface PageChunk {
  index: number
  page: number
  total: number
  screenshot: string
}

export interface BookMeta {
  asin?: string
  title: string
  authorList: Array<string>
  cover?: string
  language?: string
  publisher?: string
  releaseDate?: string
}

export interface BookMetadata {
  info: Record<string, any>
  meta: BookMeta
  toc: TocItem[]
  pages: PageChunk[]
}

