import { cohere } from '@ai-sdk/cohere'
import { embed, rerank } from 'ai'
import { cosineDistance, sql } from 'drizzle-orm'

import { db } from '@/db'
import { documentChunks } from '@/schema'

const EMBEDDING_MODEL = 'embed-v4.0'
const RERANK_MODEL = 'rerank-v4.0-pro'
const EMBEDDING_DIMENSIONS = 512
const MIN_RERANK_SCORE = 0.28
const MAX_VECTOR_DISTANCE = 0.82
const RERANK_FALLBACK_MIN_RESULTS = 3
const MAX_CONTEXT_CHARS = 5_000
const MAX_CHUNK_CHARS_IN_CONTEXT = 850

const PREVIEW_QUERY_CHARS = 120

export type RetrievedChunk = {
  id: string
  parentUrl: string
  pageTitle: string | null
  chunkText: string
  createdAt: Date | null
  vectorDistance: number
  similarity: number
  rerankScore?: number
}

export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const { embedding } = await embed({
    model: cohere.embedding(EMBEDDING_MODEL),
    value: query,
    providerOptions: {
      cohere: {
        inputType: 'search_query',
        outputDimension: EMBEDDING_DIMENSIONS,
      },
    },
  })

  if (!embedding || embedding.length === 0) {
    throw new Error('Failed to generate embedding for query.')
  }

  return embedding
}

function createRetrievalTraceId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export async function searchByEmbedding(
  embedding: number[],
  limit = 30,
  traceId?: string,
): Promise<RetrievedChunk[]> {
  const distance = cosineDistance(documentChunks.embedding, embedding)

  const rows = await db
    .select({
      id: documentChunks.id,
      parentUrl: documentChunks.parentUrl,
      pageTitle: documentChunks.pageTitle,
      chunkText: documentChunks.chunkText,
      createdAt: documentChunks.createdAt,
      distance,
    })
    .from(documentChunks)
    .where(sql`${distance} <= ${MAX_VECTOR_DISTANCE}`)
    .orderBy(distance)
    .limit(limit)

  const minDistance = rows.length > 0 ? Math.min(...rows.map((row) => Number(row.distance))) : null
  const maxDistance = rows.length > 0 ? Math.max(...rows.map((row) => Number(row.distance))) : null
  const topDistances = rows.slice(0, 5).map((row) => Number(row.distance).toFixed(4))

  console.log('[rag] vector search', {
    traceId,
    requestedLimit: limit,
    distanceThreshold: MAX_VECTOR_DISTANCE,
    retrieved: rows.length,
    minDistance,
    maxDistance,
    topDistances,
  })

  return rows.map((row) => ({
    id: row.id,
    parentUrl: row.parentUrl,
    pageTitle: row.pageTitle,
    chunkText: row.chunkText,
    createdAt: row.createdAt,
    vectorDistance: Number(row.distance),
    similarity: 1 - Number(row.distance),
  }))
}

export async function rerankChunks(query: string, chunks: RetrievedChunk[], topN = 8, traceId?: string): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) {
    console.log('[rag] rerank skipped: no candidates', { traceId })
    return []
  }

  const { ranking } = await rerank({
    model: cohere.reranking(RERANK_MODEL),
    query,
    documents: chunks.map((chunk) => [
      `Title: ${chunk.pageTitle?.trim() || 'Untitled page'}`,
      `URL: ${chunk.parentUrl}`,
      '',
      chunk.chunkText,
    ].join('\n')),
    topN,
  })

  const reranked = ranking.reduce<RetrievedChunk[]>((accumulator, item) => {
    const chunk = chunks[item.originalIndex]
    if (!chunk) {
      return accumulator
    }

    accumulator.push({
      ...chunk,
      rerankScore: item.score,
    })

    return accumulator
  }, [])

  const filtered = reranked.filter((chunk) => (chunk.rerankScore ?? 0) >= MIN_RERANK_SCORE)
  const selected =
    filtered.length >= RERANK_FALLBACK_MIN_RESULTS
      ? filtered
      : reranked.slice(0, Math.min(RERANK_FALLBACK_MIN_RESULTS, reranked.length))
  const minScore = reranked.length > 0 ? Math.min(...reranked.map((chunk) => chunk.rerankScore ?? 0)) : null
  const maxScore = reranked.length > 0 ? Math.max(...reranked.map((chunk) => chunk.rerankScore ?? 0)) : null
  const topScores = reranked.slice(0, 5).map((chunk) => Number(chunk.rerankScore ?? 0).toFixed(4))

  console.log('[rag] rerank summary', {
    traceId,
    queryPreview: query.slice(0, PREVIEW_QUERY_CHARS),
    inputCandidates: chunks.length,
    rerankResults: reranked.length,
    minRerankScore: MIN_RERANK_SCORE,
    minScore,
    maxScore,
    topScores,
    passedScoreFilter: filtered.length,
    selectedAfterFallback: selected.length,
    droppedByScore: reranked.length - filtered.length,
  })

  return selected
}

export async function retrieveRelevantChunks(query: string, candidateLimit = 30, topN = 8): Promise<RetrievedChunk[]> {
  const traceId = createRetrievalTraceId()
  const startedAt = Date.now()

  console.log('[rag] retrieval start', {
    traceId,
    queryPreview: query.slice(0, PREVIEW_QUERY_CHARS),
    queryLength: query.length,
    candidateLimit,
    topN,
    distanceThreshold: MAX_VECTOR_DISTANCE,
    minRerankScore: MIN_RERANK_SCORE,
  })

  const embeddingStartedAt = Date.now()
  const embedding = await generateQueryEmbedding(query)
  const embeddingMs = Date.now() - embeddingStartedAt

  const vectorStartedAt = Date.now()
  const candidates = await searchByEmbedding(embedding, candidateLimit, traceId)

  const vectorSearchMs = Date.now() - vectorStartedAt

  if (candidates.length === 0) {
    console.log('[rag] retrieval stop', {
      traceId,
      stage: 'vector-search',
      reason: 'no-candidates-after-distance-threshold',
      distanceThreshold: MAX_VECTOR_DISTANCE,
      embeddingMs,
      vectorSearchMs,
      totalMs: Date.now() - startedAt,
    })

    return []
  }

  const rerankStartedAt = Date.now()
  const reranked = await rerankChunks(query, candidates, topN, traceId)
  const rerankMs = Date.now() - rerankStartedAt

  if (reranked.length === 0) {
    console.log('[rag] retrieval stop', {
      traceId,
      stage: 'rerank-filter',
      reason: 'no-candidates-passed-rerank-threshold',
      minRerankScore: MIN_RERANK_SCORE,
      embeddingMs,
      vectorSearchMs,
      rerankMs,
      totalMs: Date.now() - startedAt,
    })
  }

  console.log('[rag] retrieval done', {
    traceId,
    candidateCount: candidates.length,
    finalChunkCount: reranked.length,
    embeddingMs,
    vectorSearchMs,
    rerankMs,
    totalMs: Date.now() - startedAt,
  })

  return reranked
}

export function buildRagContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    console.log('[rag] context build: no chunks selected')
    return 'No relevant indexed content was found for this question.'
  }

  const selectedBlocks: string[] = []
  let currentSize = 0

  for (const [index, chunk] of chunks.entries()) {
    const title = chunk.pageTitle?.trim() || 'Untitled page'
    const score = chunk.rerankScore ?? chunk.similarity
    const trimmedText = chunk.chunkText.slice(0, MAX_CHUNK_CHARS_IN_CONTEXT)

    const block = [
      `Source ${index + 1}`,
      `URL: ${chunk.parentUrl}`,
      `Title: ${title}`,
      `Score: ${score.toFixed(4)}`,
      trimmedText,
    ].join('\n')

    const nextSize = currentSize + block.length
    if (selectedBlocks.length > 0 && nextSize > MAX_CONTEXT_CHARS) {
      break
    }

    selectedBlocks.push(block)
    currentSize = nextSize
  }

  const context = selectedBlocks.join('\n\n---\n\n')

  console.log('[rag] context build', {
    chunksUsed: selectedBlocks.length,
    maxContextChars: MAX_CONTEXT_CHARS,
    maxChunkCharsInContext: MAX_CHUNK_CHARS_IN_CONTEXT,
    contextChars: context.length,
  })

  return context
}

export async function getRagContextForQuery(query: string, candidateLimit = 30, topN = 8) {
  if (!query.trim()) {
    return {
      chunks: [] as RetrievedChunk[],
      context: 'No user query provided.',
    }
  }

  const chunks = await retrieveRelevantChunks(query, candidateLimit, topN)
  return {
    chunks,
    context: buildRagContext(chunks),
  }
}
