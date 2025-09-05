import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import delay from 'delay'
import crypto from 'node:crypto'
import { chromium, type Frame, type Page } from 'playwright'

import type { BookMetadata, PageChunk, TocItem } from './types'
import { assert } from './utils'

function parseIaIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/')
    const idx = parts.indexOf('details')
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]
    return null
  } catch {
    return null
  }
}

async function ensureLoggedIn(baseUrl: string, email: string, password: string, dataDir: string) {
  // Uses a persistent context, so usually this is a no-op after first run.
  const context = await chromium.launchPersistentContext(dataDir, {
    headless: false,
    deviceScaleFactor: 2,
    viewport: { width: 1366, height: 900 }
  })
  const page = await context.newPage()

  const isLoggedIn = async () => {
    try {
      const sel = 'a[href="/account.php"], a[href*="/logout"], #navbar .account, #navright .tools a[aria-label*="account" i]'
      return await page.locator(sel).first().isVisible({ timeout: 2000 })
    } catch { return false }
  }

  const goToLogin = async () => {
    // Try direct login URLs first
    const loginUrls = [
      'https://archive.org/account/login.php',
      'https://archive.org/account/login'
    ]
    for (const url of loginUrls) {
      try {
        await page.goto(url, { timeout: 30_000 })
        await delay(500)
        if (/\/account\/login/.test(page.url())) return
      } catch {}
    }
    // Click a login link if present
    const loginLinkSel = [
      'a[href*="/account/login"]',
      'a:has-text("Sign In")',
      'a:has-text("Log In")',
      'button:has-text("Sign In")',
      'button:has-text("Log In")'
    ].join(', ')
    try {
      const $login = page.locator(loginLinkSel).first()
      await $login.click({ timeout: 10_000 })
      await delay(500)
    } catch {}
  }

  const fillLogin = async () => {
    const emailSel = [
      'input[name="username"]',
      'input#username',
      'input[name="email"]',
      'input#email',
      'input#input-email',
      'input[name="login"]',
      'input[type="email"]'
    ].join(', ')
    const passSel = [
      'input[name="password"]',
      'input#password',
      'input[type="password"]'
    ].join(', ')
    const submitSel = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'input[value*="Sign in" i]',
      'input[value*="Log in" i]'
    ].join(', ')

    // Wait for any email/username input to appear
    const $email = page.locator(emailSel).first()
    await $email.waitFor({ state: 'visible', timeout: 20_000 })
    await $email.fill(email)

    // If password input not visible yet, click Next/Continue
    const $pass = page.locator(passSel).first()
    if (!(await $pass.isVisible().catch(() => false))) {
      try {
        await page.locator('button:has-text("Next"), button:has-text("Continue"), input[type="submit"]').first().click({ timeout: 5000 })
        await delay(500)
      } catch {}
    }

    await page.locator(passSel).first().fill(password)
    await Promise.any([
      page.locator(submitSel).first().click({ timeout: 10_000 }),
      page.keyboard.press('Enter')
    ])
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  }

  // Navigate to a trusted IA page first, then proceed
  try {
    await page.goto(baseUrl, { timeout: 60_000 })
  } catch {}

  if (!(await isLoggedIn())) {
    await goToLogin()
    try {
      await fillLogin()
    } catch (err) {
      // If this login variant failed, try the alternate login URL once
      try {
        await page.goto('https://archive.org/account/login', { timeout: 30_000 })
        await delay(500)
        await fillLogin()
      } catch (err2) {
        // give up and proceed; capture step may still work if session is valid
      }
    }
  }

  // Return to the requested base URL
  try {
    await page.goto(baseUrl, { timeout: 60_000 })
  } catch {}

  await page.close()
  await context.close()
}

async function findReaderContext(page: Page): Promise<Frame | Page> {
  const readerSel = '#BookReader, .BRbook, #BRcontainer'
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    // include main frame + child frames
    const frames: Array<Frame | Page> = [page, ...page.frames()]
    for (const f of frames) {
      try {
        const count = await (f as any).locator(readerSel).count()
        if (count > 0) return f
      } catch {}
    }
    await delay(500)
  }
  throw new Error('BookReader view not found (iframe or main page)')
}

async function captureIaBook(iaId: string, iaUrl?: string) {
  const outDir = path.join('out', iaId)
  const dataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, 'pages')
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  // Normalize URL to 2-up theater view (full-screen pages) and optional start page
  function normalizeIaUrl(rawUrl: string | undefined, id: string) {
    const startPage = Number(process.env.IA_START_PAGE || '0')
    try {
      const u = new URL(rawUrl || `https://archive.org/details/${id}`)
      if (!/\/details\//.test(u.pathname)) u.pathname = `/details/${id}`
      if (startPage > 0) {
        if (/\/page\/n\d+/.test(u.pathname)) u.pathname = u.pathname.replace(/\/page\/n\d+/, `/page/n${startPage}`)
        else if (/\/mode\//.test(u.pathname)) u.pathname = u.pathname.replace(/(\/details\/${id})/, `$1/page/n${startPage}`)
        else u.pathname = `/details/${id}/page/n${startPage}`
      }
      if (/\/mode\//.test(u.pathname)) u.pathname = u.pathname.replace(/\/mode\/\w+/, '/mode/2up')
      else u.pathname = u.pathname.replace(new RegExp(`^/details/${id}`), `/details/${id}/mode/2up`)
      u.searchParams.set('view', 'theater')
      return u.toString()
    } catch {
      return `https://archive.org/details/${id}/mode/2up?view=theater`
    }
  }

  const iaDetailsUrl = normalizeIaUrl(iaUrl, iaId)

  const context = await chromium.launchPersistentContext(dataDir, {
    headless: false,
    deviceScaleFactor: 2,
    viewport: { width: 1366, height: 900 }
  })
  const page = await context.newPage()

  await page.goto(iaDetailsUrl, { timeout: 60_000 })
  await delay(1000)

  // Borrow helpers
  const attemptBorrowOn = async (scope: Page | Frame) => {
    const tryClick = async (sel: string, t = 2000) => {
      try {
        const $btn = (scope as any).locator(sel).first()
        if (await $btn.isVisible({ timeout: 500 }).catch(() => false)) {
          try { console.warn(`clicking borrow`, { sel }) } catch {}
          await $btn.click({ timeout: t }).catch(() => {})
          await delay(1200)
          return true
        }
      } catch {}
      return false
    }
    const variants = [
      'role=button[name=/^borrow/i]',
      'role=link[name=/^borrow/i]',
      'button:has-text("Borrow")',
      'a:has-text("Borrow")',
      'button:has-text("Borrow for")',
      'button:has-text("Borrow This Book")',
      'text=/^Borrow( for \d+ (hour|hours|days))?$/i'
    ]
    for (const v of variants) {
      if (await tryClick(v)) return true
    }
    return false
  }

  // Click Borrow on details page if needed
  await attemptBorrowOn(page)

  // If a "Read online" link/button exists, click it
  try {
    const readButtons = [
      'a:has-text("Read online")',
      'button:has-text("Read online")'
    ]
    for (const sel of readButtons) {
      const $rb = page.locator(sel).first()
      if (await $rb.isVisible({ timeout: 1000 }).catch(() => false)) {
        await $rb.click({ timeout: 3000 }).catch(() => {})
        await delay(1500)
        break
      }
    }
  } catch {}

  // Ensure we are in theater + 2up mode
  try {
    let current = new URL(page.url())
    let changed = false
    if (current.searchParams.get('view') !== 'theater') { current.searchParams.set('view', 'theater'); changed = true }
    if (!/\/mode\/2up/.test(current.pathname)) { current.pathname = current.pathname.replace(/\/mode\/\w+/, '/mode/2up'); changed = true }
    if (changed) { await page.goto(current.toString(), { timeout: 60_000 }); await delay(1000) }
  } catch {}

  // Try to locate the BookReader container (main page or iframe)
  let ctx: Frame | Page
  try {
    ctx = await findReaderContext(page)
  } catch (err) {
    // Fallback: try the legacy /stream URL
    try {
      const streamUrl = `https://archive.org/stream/${iaId}?ui=embed#mode/1up`
      await page.goto(streamUrl, { timeout: 60_000 })
      await delay(1000)
      ctx = await findReaderContext(page)
    } catch (err2) {
      throw err
    }
  }

  // Sometimes Borrow overlay appears inside the reader; try again there
  try { await attemptBorrowOn(ctx as any) } catch {}

  // Attempt to read BookReader globals from the reader context
  async function getBrState() {
    return await (ctx as any).evaluate(() => {
      const w: any = window as any
      // instance detection across versions
      const br: any = w.br || (w.BookReader && (w.BookReader.instances?.[0] || w.BookReader.instance))
      let pageNum = br?.getPageNum?.() ?? br?.getPage?.() ?? br?.pageNum ?? br?.page
      // normalize to 1-based if 0-based
      if (pageNum === 0) pageNum = 1
      let total = br?.getNumLeafs?.() ?? br?.leafMap?.length ?? br?.numLeafs ?? br?.pages?.length
      const title = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null)?.content || document.title
      const authorMeta = (document.querySelector('meta[name="creator"]') as HTMLMetaElement | null)?.content
      const container = document.querySelector('#BookReader, .BRbook, #BRcontainer') as HTMLElement | null
      const imgSrcs = container ? Array.from(container.querySelectorAll('img[src]')).map((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src).filter(Boolean) : []
      // A lightweight signature of visible tiles to detect visual change when page number is unavailable
      const sig = (imgSrcs.slice(0, 12).join('|') || '') + '|' + imgSrcs.length
      const footerEl = document.querySelector('.BRpageinfo,.BRpagenum,#BRpagenum,.BRinfo,.brpageinfo') as HTMLElement | null
      const footerText = footerEl?.textContent || ''
      return { page: pageNum, total, title, authorMeta, sig, footerText }
    })
  }

  // Helper to wait until the current page is visually rendered
  async function waitForPageStable() {
    const tileStable = Number(process.env.IA_TILE_STABLE_MS ?? '800')
    const pageDelay = Number(process.env.IA_PAGE_DELAY_MS ?? '1200')
    // Wait for main container
    const pageContainerSel = '#BookReader, .BRbook, #BRcontainer'
    const $container = (ctx as any).locator(pageContainerSel).first()
    await $container.waitFor({ state: 'visible', timeout: 60_000 })
    // wait a bit for tiles/images to render
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    // Wait for reader spinner/loader to disappear
    try {
      const spinnerSel = [
        '#BookReader .BRloading',
        '#BookReader .loading',
        '#BookReader .spinner',
        '#BookReader .BRspinner',
        '.BRbook .BRloading',
        '.BRbook .loading',
        '.BRbook .spinner',
        '.BRbook .BRspinner'
      ].join(', ')
      const deadline = Date.now() + Number(process.env.IA_SPINNER_TIMEOUT_MS ?? '45000')
      while (Date.now() < deadline) {
        const visible = await (ctx as any).locator(spinnerSel).first().isVisible({ timeout: 200 }).catch(() => false)
        if (!visible) break
        await delay(250)
      }
    } catch {}
    // Ensure images within the container are complete
    try {
      await (ctx as any).evaluate(async (sel) => {
        const container = document.querySelector(sel) as HTMLElement | null
        if (!container) return
        const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[]
        await Promise.all(
          imgs
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise<void>((resolve) => {
                  img.addEventListener('load', () => resolve(), { once: true })
                  img.addEventListener('error', () => resolve(), { once: true })
                })
            )
        )
      }, pageContainerSel)
    } catch {}
    await delay(tileStable)
    await delay(pageDelay)
    return $container
  }

  // Prefer the inner page spread element in 2up theater view
  async function getCaptureTarget() {
    const sels = [
      '#BookReader .BRpageview',
      '#BookReader .BRtwoPageView',
      '#BookReader .BRtwopage',
      '#BookReader .BRdoublepage',
      '#BookReader .BRpageimage',
      '#BookReader canvas',
      '.BRbook .BRpageview',
      '.BRbook .BRtwoPageView',
      '.BRbook .BRdoublepage',
      '.BRbook .BRpageimage',
      '.BRbook canvas',
      '#BookReader'
    ].join(', ')
    const $el = (ctx as any).locator(sels).first()
    await $el.waitFor({ state: 'visible', timeout: 60_000 })
    return $el
  }

  // Determine total page count
  let { page: currentPage, total, title, authorMeta, sig: prevSig, footerText } = await getBrState()
  // Fallback: if total is missing, try parsing footer UI text
  if (!total) {
    try {
      const footer = footerText || (await (ctx as any)
        .locator('.BRpageinfo,.BRpagenum,.BRpagebar, #BRpagenum, .BRinfo, .brpageinfo')
        .first()
        .textContent({ timeout: 5000 }))
      const m = footer?.match(/(\d+)\s*of\s*(\d+)/i)
      if (m) total = Number(m[2])
    } catch {}
  }
  // Do not fail if total is unknown yet; we’ll derive it after capture
  if (!total || total <= 0) {
    total = Number(process.env.IA_MAX_PAGES || '0') || 9999
  }

  // Optional limits
  const maxPagesEnv = Number(process.env.IA_MAX_PAGES || '0')
  const startPageEnv = Number(process.env.IA_START_PAGE || '1')
  const resumeEnv = process.env.IA_RESUME === '1'
  const captureUntil = maxPagesEnv > 0 ? Math.min(total, maxPagesEnv) : total

  // Force a specific starting page/spread unless resuming is requested
  if (!resumeEnv && startPageEnv >= 1) {
    try {
      const desiredLeaf = Math.max(0, startPageEnv - 1)
      await (ctx as any).evaluate((leaf) => {
        const w: any = window as any
        const br: any = w.br || (w.BookReader && (w.BookReader.instances?.[0] || w.BookReader.instance))
        if (!br) return
        if (leaf <= 0 && br.first) br.first()
        else if (br.jumpTo) br.jumpTo(leaf)
      }, desiredLeaf)
      await waitForPageStable()
      const st = await getBrState()
      currentPage = st.page
    } catch {}
  }

  const indexPad = Math.max(2, `${captureUntil}`.length)
  const pages: PageChunk[] = []

  // Basic TOC: single section covering full content if no sidebar TOC
  const toc: TocItem[] = [
    { title: title || 'Book', page: 1, total },
    { title: 'End', page: total, total }
  ]

  // Capture loop: fixed number of pages or until end
  let lastSig = ''
  let lastPageNum = -1
  let lastHash = ''
  const maxVerifyRetries = Number(process.env.IA_MAX_RETRIES ?? '10')
  async function advanceOnce(prevSig: string, prevPage: number): Promise<boolean> {
    // Try br.next() first
    try { await (ctx as any).evaluate(() => (window as any).br?.next?.()) } catch {}
    await waitForPageStable()
    let st = await getBrState()
    if ((st.page ?? -1) !== prevPage || (st.sig && st.sig !== prevSig)) return true
    // Then try clicking next button once
    try {
      await (ctx as any)
        .locator('#BRnavnext, .BRnext, .brnext, .bookreader-paged .BRnext, button[title="Next"], a[title="Next"], [aria-label="Next"]')
        .first()
        .click({ timeout: 1200 })
    } catch {}
    await waitForPageStable()
    st = await getBrState()
    if ((st.page ?? -1) !== prevPage || (st.sig && st.sig !== prevSig)) return true
    // Finally, keyboard right
    try { await page.keyboard.press('ArrowRight') } catch {}
    await waitForPageStable()
    st = await getBrState()
    return (st.page ?? -1) !== prevPage || (st.sig && st.sig !== prevSig)
  }
  for (let i = 0; i < captureUntil; i++) {
    // Ensure we actually advanced: if sig/page unchanged, try to advance/borrow again
    let st = await getBrState()
    if (i > 0 && (st.sig === lastSig || (st.page ?? -1) === lastPageNum)) {
      let tried = 0
      while (tried < maxVerifyRetries) {
        const changed = await advanceOnce(lastSig, lastPageNum)
        if (changed) { st = await getBrState(); break }
        try { await attemptBorrowOn(ctx as any) } catch {}
        tried++
      }
      if (tried >= maxVerifyRetries && (st.sig === lastSig || (st.page ?? -1) === lastPageNum)) {
        try { console.warn('no visual change after retries; stopping early') } catch {}
        break
      }
    }

    const brBefore = st

    await waitForPageStable()
    const $target = await getCaptureTarget()
    let buf: Buffer = await $target.screenshot({ type: 'png', scale: 'css' })
    // If identical to prior capture (hash), try to advance once and recapture
    let hash = crypto.createHash('sha1').update(buf).digest('hex')
    if (hash === lastHash && i > 0) {
      try { await (ctx as any).evaluate(() => (window as any).br?.next?.()) } catch {}
      try { await (ctx as any).locator('#BRnavnext, .BRnext, .brnext, button[title="Next"], a[title="Next"]').first().click({ timeout: 500 }).catch(() => {}) } catch {}
      await waitForPageStable()
      buf = await $target.screenshot({ type: 'png', scale: 'css' })
      hash = crypto.createHash('sha1').update(buf).digest('hex')
    }

    const pageNum = brBefore.page ?? i + 1
    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${i}`.padStart(indexPad, '0') + '-' + `${pageNum}`.padStart(indexPad, '0') + '.png'
    )
    await fs.writeFile(screenshotPath, buf)
    pages.push({ index: i, page: pageNum, total, screenshot: screenshotPath })
    try { console.warn(`captured page`, { index: i, pageNum, screenshotPath }) } catch {}
    lastSig = brBefore.sig || lastSig
    lastPageNum = pageNum
    lastHash = hash

    // Advance exactly once using a single method
    await advanceOnce(lastSig, lastPageNum).catch(() => {})
  }

  // Build metadata.json compatible with downstream exporter
  const cleanTitle = (title || iaId).replace(/\s*:\s*Free Download.*$/i, '')
  const meta = {
    asin: iaId,
    title: cleanTitle,
    authorList: authorMeta ? [authorMeta] : ['Unknown']
  }

  // Derive final total from last captured page if we had no reliable total
  const finalTotal = pages.length ? pages[pages.length - 1]!.page : total
  const metadata: BookMetadata = {
    info: {},
    meta: { ...meta, title: meta.title, authorList: meta.authorList },
    toc: [
      { title: (cleanTitle || 'Book'), page: 1, total: finalTotal },
      { title: 'End', page: finalTotal, total: finalTotal }
    ],
    pages
  }

  await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
  console.log(JSON.stringify(metadata, null, 2))

  await page.close()
  await context.close()
}

async function main() {
  const iaUrl = process.env.IA_URL || ''
  let iaId = process.env.IA_ID || ''
  if (!iaId && iaUrl) {
    iaId = parseIaIdFromUrl(iaUrl) || ''
  }
  assert(iaId, 'IA_ID or IA_URL (resolvable) is required')

  const email = process.env.IA_EMAIL
  const password = process.env.IA_PASSWORD
  assert(email, 'IA_EMAIL is required')
  assert(password, 'IA_PASSWORD is required')

  const baseUrl = iaUrl || `https://archive.org/details/${iaId}`
  const dataDir = path.join('out', iaId, 'data')
  await ensureLoggedIn(baseUrl, email!, password!, dataDir)
  await captureIaBook(iaId, iaUrl)
}

await main()
