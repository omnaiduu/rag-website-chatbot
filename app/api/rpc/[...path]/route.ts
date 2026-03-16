import { RPCHandler } from '@orpc/server/fetch'
import { eventIterator, onError, ORPCError, os, withEventMeta } from '@orpc/server'
import { z } from 'zod'
import { chromium } from 'playwright'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { cohere } from '@ai-sdk/cohere'
import { embedMany } from 'ai'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { documentChunks } from '@/schema'

const BATCH_SIZE = 50
const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 80
const MIN_CHUNK_CHARS = 180
const MAX_CHUNK_CHARS = 900
const EMBEDDING_DIMENSIONS = 512
const MIN_HTML_LENGTH_FOR_FETCH_ONLY = 1200
const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; TanStackStartRAGBot/1.0)'

const normalizedUrlSchema = z.url().transform((value) => normalizeUrl(value))

const ingestInputSchema = z.object({
    rootUrl: normalizedUrlSchema,
    maxPages: z.coerce.number().int().positive().default(5),
})

const deleteInputSchema = z.object({
    rootUrl: normalizedUrlSchema,
})

const listIngestSourceSchema = z.object({
    origin: z.string(),
    rootUrl: z.string(),
    pageUrls: z.array(z.string()),
    visitedPages: z.number().int().nonnegative(),
    pagesWithContent: z.number().int().nonnegative(),
    totalChunks: z.number().int().nonnegative(),
    insertedChunks: z.number().int().nonnegative(),
    lastIndexedAt: z.string(),
})

const ingestProgressSchema = z.object({
    type: z.enum(['status', 'page', 'batch', 'error', 'completed']),
    stage: z.enum(['init', 'crawl', 'extract', 'chunk', 'embed', 'store', 'done']),
    area: z.enum(['configuration', 'crawler', 'content', 'embeddings', 'database', 'summary']),
    message: z.string(),
    timestamp: z.string(),
    progress: z.number().min(0).max(100),
    counts: z.object({
        visitedPages: z.number().int().nonnegative(),
        queuedPages: z.number().int().nonnegative(),
        pagesWithContent: z.number().int().nonnegative(),
        totalChunks: z.number().int().nonnegative(),
        pendingChunks: z.number().int().nonnegative(),
        insertedChunks: z.number().int().nonnegative(),
        maxPages: z.number().int().positive(),
    }),
    url: z.string().optional(),
    mode: z.enum(['fetch', 'playwright']).optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
})

const ingestResultSchema = z.object({
    success: z.literal(true),
    message: z.string(),
    rootUrl: z.string(),
    stopReason: z.enum(['max_pages_reached', 'queue_empty', 'aborted']),
    visitedPages: z.number().int().nonnegative(),
    pagesWithContent: z.number().int().nonnegative(),
    totalChunks: z.number().int().nonnegative(),
    insertedChunks: z.number().int().nonnegative(),
})

type IngestProgressEvent = z.infer<typeof ingestProgressSchema>
type IngestProgressPayload = Omit<IngestProgressEvent, 'timestamp' | 'counts'>
type IngestResult = z.infer<typeof ingestResultSchema>
type IngestSourceSummary = z.infer<typeof listIngestSourceSchema>

type QueueItem = {
    url: string
    parentUrl: string
}

type PendingChunk = {
    parentUrl: string
    pageTitle: string
    chunkText: string
}

const turndownService = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
})
turndownService.use(gfm)

function normalizeUrl(value: string): string {
    const parsed = new URL(value)
    parsed.hash = ''

    if (parsed.pathname !== '/') {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    }

    parsed.searchParams.sort()
    return parsed.toString()
}

function shouldUsePlaywright(html: string): boolean {
    return html.trim().length < MIN_HTML_LENGTH_FOR_FETCH_ONLY
}

async function renderWithPlaywright(url: string): Promise<string> {
    const browser = await chromium.launch({ headless: true })

    try {
        const page = await browser.newPage()
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
        return await page.content()
    } finally {
        await browser.close()
    }
}

async function scrapeHtml(url: string): Promise<{ html: string, mode: 'fetch' | 'playwright' }> {
    try {
        const response = await fetch(url, {
            redirect: 'follow',
            headers: {
                'User-Agent': FETCH_USER_AGENT,
            },
        })

        if (!response.ok) {
            throw new Error(`Fetch failed with HTTP ${response.status}`)
        }

        const html = await response.text()
        if (shouldUsePlaywright(html)) {
            console.log(`[ingest] fallback to Playwright for ${url}`)
            return { html: await renderWithPlaywright(url), mode: 'playwright' }
        }

        return { html, mode: 'fetch' }
    } catch (error) {
        console.warn(`[ingest] fetch path failed for ${url}, retrying with Playwright`, error)
        return { html: await renderWithPlaywright(url), mode: 'playwright' }
    }
}

function extractSameDomainLinks(document: Document, pageUrl: string, hostname: string): string[] {
    const links = new Set<string>()

    for (const anchor of document.querySelectorAll('a[href]')) {
        const rawHref = anchor.getAttribute('href')?.trim()
        if (!rawHref) {
            continue
        }

        if (rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:') || rawHref.startsWith('javascript:')) {
            continue
        }

        try {
            const resolved = new URL(rawHref, pageUrl)
            if (resolved.hostname !== hostname) {
                continue
            }

            links.add(normalizeUrl(resolved.toString()))
        } catch {
            // Ignore malformed links while crawling.
        }
    }

    return [...links]
}

function extractMarkdownAndLinks(html: string, pageUrl: string, hostname: string): { markdown: string, pageTitle: string, links: string[] } {
    const dom = new JSDOM(html, { url: pageUrl })

    try {
        const links = extractSameDomainLinks(dom.window.document, pageUrl, hostname)
        const reader = new Readability(dom.window.document)
        const article = reader.parse()

        const articleHtml = article?.content ?? dom.window.document.body?.innerHTML ?? ''
        const markdown = turndownService.turndown(articleHtml).trim()
        const pageTitle = (article?.title ?? dom.window.document.title ?? pageUrl).trim() || pageUrl

        return { markdown, pageTitle, links }
    } finally {
        dom.window.close()
    }
}

function normalizeChunkText(chunk: string): string {
    return chunk
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

async function buildChunks(markdown: string, splitter: RecursiveCharacterTextSplitter): Promise<string[]> {
    const rawChunks = await splitter.splitText(markdown)

    return rawChunks
        .map((chunk) => normalizeChunkText(chunk))
        .filter((chunk) => chunk.length >= MIN_CHUNK_CHARS)
        .map((chunk) => chunk.slice(0, MAX_CHUNK_CHARS))
}

const ingest = os
    .input(ingestInputSchema)
    .output(eventIterator(ingestProgressSchema, ingestResultSchema))
    .handler(async function* ({ input, signal, lastEventId }) {
        const normalizedRootUrl = input.rootUrl
        const rootHostname = new URL(normalizedRootUrl).hostname

        const maxPages = input.maxPages
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: CHUNK_SIZE,
            chunkOverlap: CHUNK_OVERLAP,
        })

        const queue: QueueItem[] = [{ url: normalizedRootUrl, parentUrl: normalizedRootUrl }]
        const visitedUrls = new Set<string>()
        const queuedUrls = new Set<string>([normalizedRootUrl])
        const pendingChunks: PendingChunk[] = []

        let pagesWithContent = 0
        let totalChunks = 0
        let insertedChunks = 0
        let eventId = Number.parseInt(lastEventId ?? '0', 10)
        if (Number.isNaN(eventId) || eventId < 0) {
            eventId = 0
        }

        const counts = () => ({
            visitedPages: visitedUrls.size,
            queuedPages: queue.length,
            pagesWithContent,
            totalChunks,
            pendingChunks: pendingChunks.length,
            insertedChunks,
            maxPages,
        })

        const computeProgress = () => {
            const crawlProgress = maxPages === 0 ? 0 : (visitedUrls.size / maxPages) * 70
            const indexProgress = totalChunks === 0
                ? 0
                : (insertedChunks / Math.max(totalChunks, insertedChunks)) * 30

            return Math.round(Math.min(99, crawlProgress + indexProgress))
        }

        const streamEvent = (event: IngestProgressPayload) => {
            return withEventMeta({
                ...event,
                timestamp: new Date().toISOString(),
                counts: counts(),
            }, {
                id: String(++eventId),
                retry: 5_000,
            })
        }

        const flushBatch = async (reason: string): Promise<IngestProgressPayload | null> => {
            if (pendingChunks.length === 0) {
                return null
            }

            const batch = pendingChunks.splice(0)
            console.log(`[ingest] embedding batch size=${batch.length} reason=${reason}`)

            const { embeddings } = await embedMany({
                model: cohere.embedding('embed-v4.0'),
                values: batch.map((item) => item.chunkText),
                providerOptions: {
                    cohere: {
                        inputType: 'search_document',
                        outputDimension: EMBEDDING_DIMENSIONS,
                    },
                },
            })

            if (embeddings.length !== batch.length) {
                throw new Error(`Embedding count mismatch. expected=${batch.length}, received=${embeddings.length}`)
            }

            try {
                await db.insert(documentChunks).values(
                    batch.map((item, index) => ({
                        parentUrl: item.parentUrl,
                        pageTitle: item.pageTitle,
                        chunkText: item.chunkText,
                        embedding: embeddings[index],
                    })),
                )
            } catch (error) {
                throw new ORPCError('INTERNAL_SERVER_ERROR', {
                    message: `Failed to store embedded chunks in database: ${error instanceof Error ? error.message : String(error)}`,
                })
            }

            insertedChunks += batch.length
            console.log(`[ingest] inserted ${batch.length} chunks (total=${insertedChunks})`)

            return {
                type: 'batch',
                stage: 'store',
                area: 'database',
                message: `Stored ${batch.length} embedded chunks`,
                progress: computeProgress(),
                reason,
            }
        }

        console.log(`[ingest] start root=${normalizedRootUrl} maxPages=${maxPages}`)
        yield streamEvent({
            type: 'status',
            stage: 'init',
            area: 'configuration',
            message: `Started ingest for ${normalizedRootUrl}`,
            progress: 0,
            reason: lastEventId ? `resumed_from_${lastEventId}` : 'fresh_start',
        })

        while (queue.length > 0 && visitedUrls.size < maxPages) {
            if (signal?.aborted) {
                console.warn('[ingest] request aborted by client')
                break
            }

            const current = queue.shift()
            if (!current) {
                break
            }

            queuedUrls.delete(current.url)

            if (visitedUrls.has(current.url)) {
                continue
            }

            visitedUrls.add(current.url)
            console.log(`[ingest] crawling (${visitedUrls.size}/${maxPages}) ${current.url}`)
            yield streamEvent({
                type: 'page',
                stage: 'crawl',
                area: 'crawler',
                message: `Crawling page ${visitedUrls.size}/${maxPages}`,
                progress: computeProgress(),
                url: current.url,
            })

            try {
                const { html, mode } = await scrapeHtml(current.url)
                console.log(`[ingest] scrape mode=${mode} url=${current.url}`)
                yield streamEvent({
                    type: 'page',
                    stage: 'extract',
                    area: 'content',
                    message: `Extracted HTML using ${mode}`,
                    progress: computeProgress(),
                    url: current.url,
                    mode,
                })

                const { markdown, pageTitle, links } = extractMarkdownAndLinks(html, current.url, rootHostname)

                for (const discoveredUrl of links) {
                    if (visitedUrls.has(discoveredUrl) || queuedUrls.has(discoveredUrl)) {
                        continue
                    }

                    queue.push({
                        url: discoveredUrl,
                        parentUrl: current.url,
                    })
                    queuedUrls.add(discoveredUrl)
                }

                if (!markdown) {
                    console.log(`[ingest] no readable markdown from ${current.url}`)
                    yield streamEvent({
                        type: 'status',
                        stage: 'extract',
                        area: 'content',
                        message: 'No readable markdown found on page',
                        progress: computeProgress(),
                        url: current.url,
                    })
                    continue
                }

                const chunks = await buildChunks(markdown, splitter)

                if (chunks.length === 0) {
                    console.log(`[ingest] no chunks produced for ${current.url}`)
                    yield streamEvent({
                        type: 'status',
                        stage: 'chunk',
                        area: 'content',
                        message: 'No semantic chunks produced for page',
                        progress: computeProgress(),
                        url: current.url,
                    })
                    continue
                }

                pagesWithContent += 1
                totalChunks += chunks.length

                for (const chunkText of chunks) {
                    pendingChunks.push({
                        parentUrl: current.url,
                        pageTitle,
                        chunkText,
                    })
                }

                console.log(`[ingest] queued chunks=${chunks.length} pending=${pendingChunks.length} url=${current.url}`)
                yield streamEvent({
                    type: 'page',
                    stage: 'chunk',
                    area: 'content',
                    message: `Chunked page into ${chunks.length} pieces`,
                    progress: computeProgress(),
                    url: current.url,
                })

                if (pendingChunks.length >= BATCH_SIZE) {
                    yield streamEvent({
                        type: 'batch',
                        stage: 'embed',
                        area: 'embeddings',
                        message: `Embedding ${pendingChunks.length} pending chunks`,
                        progress: computeProgress(),
                        reason: 'batch-size',
                    })

                    const batchEvent = await flushBatch('batch-size')
                    if (batchEvent) {
                        yield streamEvent(batchEvent)
                    }
                }
            } catch (error) {
                console.error(`[ingest] failed page ${current.url}`, error)
                yield streamEvent({
                    type: 'error',
                    stage: 'crawl',
                    area: 'crawler',
                    message: 'Failed to process page, continuing crawl',
                    progress: computeProgress(),
                    url: current.url,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        }

        if (pendingChunks.length > 0) {
            const flushReason = signal?.aborted
                ? 'aborted'
                : queue.length === 0
                    ? 'queue-empty'
                    : 'max-pages-reached'

            yield streamEvent({
                type: 'batch',
                stage: 'embed',
                area: 'embeddings',
                message: `Embedding final ${pendingChunks.length} chunks`,
                progress: computeProgress(),
                reason: flushReason,
            })

            const finalBatchEvent = await flushBatch(flushReason)
            if (finalBatchEvent) {
                yield streamEvent(finalBatchEvent)
            }
        }

        const stopReason = signal?.aborted
            ? 'aborted'
            : visitedUrls.size >= maxPages
                ? 'max_pages_reached'
                : 'queue_empty'

        console.log(`[ingest] finished reason=${stopReason} visited=${visitedUrls.size} chunks=${totalChunks} inserted=${insertedChunks}`)
        yield streamEvent({
            type: 'completed',
            stage: 'done',
            area: 'summary',
            message: `Ingest finished with reason: ${stopReason}`,
            progress: 100,
            reason: stopReason,
            url: normalizedRootUrl,
        })

        return {
            success: true,
            message: 'Data ingested successfully',
            rootUrl: normalizedRootUrl,
            stopReason,
            visitedPages: visitedUrls.size,
            pagesWithContent,
            totalChunks,
            insertedChunks,
        }
    })

const deleteIngest = os
    .input(deleteInputSchema)
    .handler(async ({ input }) => {
        const normalizedRootUrl = input.rootUrl
        const origin = new URL(normalizedRootUrl).origin

        console.log(`[deleteIngest] deleting rows for origin=${origin}`)

        await db
            .delete(documentChunks)
            .where(sql`${documentChunks.parentUrl} LIKE ${`${origin}%`}`)

        return {
            message: 'Data deleted successfully',
            origin,
        }
    })

const listIngestSources = os
    .output(z.array(listIngestSourceSchema))
    .handler(async () => {
        const rows = await db.execute<{
            parent_url: string
            chunk_count: number | string
            last_indexed_at: string | Date | null
        }>(sql`
            SELECT
                ${documentChunks.parentUrl} AS parent_url,
                COUNT(*)::int AS chunk_count,
                MAX(${documentChunks.createdAt}) AS last_indexed_at
            FROM ${documentChunks}
            GROUP BY ${documentChunks.parentUrl}
            ORDER BY MAX(${documentChunks.createdAt}) DESC
        `)

        const byOrigin = new Map<string, {
            rootUrl: string
            pageUrls: string[]
            totalChunks: number
            lastIndexedAt: Date
        }>()

        for (const row of rows) {
            const pageUrl = row.parent_url
            const origin = new URL(pageUrl).origin
            const chunkCount = typeof row.chunk_count === 'string'
                ? Number.parseInt(row.chunk_count, 10)
                : row.chunk_count

            const parsedDate = row.last_indexed_at
                ? new Date(row.last_indexed_at)
                : new Date(0)

            const existing = byOrigin.get(origin)
            if (!existing) {
                byOrigin.set(origin, {
                    rootUrl: pageUrl,
                    pageUrls: [pageUrl],
                    totalChunks: chunkCount,
                    lastIndexedAt: parsedDate,
                })
                continue
            }

            existing.totalChunks += chunkCount
            if (!existing.pageUrls.includes(pageUrl)) {
                existing.pageUrls.push(pageUrl)
            }
            if (parsedDate > existing.lastIndexedAt) {
                existing.lastIndexedAt = parsedDate
                existing.rootUrl = pageUrl
            }
        }

        return [...byOrigin.entries()].map(([origin, source]) => ({
            origin,
            rootUrl: source.rootUrl,
            pageUrls: source.pageUrls,
            visitedPages: source.pageUrls.length,
            pagesWithContent: source.pageUrls.length,
            totalChunks: source.totalChunks,
            insertedChunks: source.totalChunks,
            lastIndexedAt: source.lastIndexedAt.toISOString(),
        }))
    })

export const router = {
    ingest,
    deleteIngest,
    listIngestSources,
}

export type AppRouter = typeof router
export type { IngestProgressEvent, IngestResult, IngestSourceSummary }

const handler = new RPCHandler(router, {
    interceptors: [
        onError((error) => {
            console.error(error)
        }),
    ],
})

async function routeHandler(request: Request) {
    const { response } = await handler.handle(request, {
        prefix: '/api/rpc',
        context: {},
    })

    return response ?? new Response('Not Found', { status: 404 })
}

export const GET = routeHandler
export const POST = routeHandler
export const PUT = routeHandler
export const PATCH = routeHandler
export const DELETE = routeHandler
export const OPTIONS = routeHandler
export const HEAD = routeHandler