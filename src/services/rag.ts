import { CohereClient } from 'cohere-ai'
import type { EmbedByTypeResponse } from 'cohere-ai/api'
import { cosineDistance } from 'drizzle-orm'

import { db } from '@/db'
import { documentChunks } from '@/schema'

const EMBEDDING_MODEL = 'embed-v4.0'
const RERANK_MODEL = 'rerank-v3.5'
const EMBEDDING_DIMENSIONS = 512
const MIN_RERANK_SCORE = 0.15

function resolveApiKey(...values: Array<string | undefined>) {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized && !normalized.startsWith('$')) {
      return normalized
    }
  }

  return undefined
}

export type RetrievedChunk = {
  id: string
  parentUrl: string
  pageTitle: string | null
  chunkText: string
  createdAt: Date | null
  similarity: number
  rerankScore?: number
}

function createCohereClient() {
  const token = resolveApiKey(process.env.cohere, process.env.COHERE_API_KEY)
  if (!token) {
    throw new Error('Missing Cohere API key. Set COHERE_API_KEY or cohere in your environment.')
  }

  return new CohereClient({ token })
}

function getFloatEmbeddings(response: EmbedByTypeResponse | { body: EmbedByTypeResponse }): number[][] {
  const payload = 'body' in response ? response.body : response
  const embeddings = payload.embeddings

  if (!Array.isArray(embeddings?.float)) {
    throw new Error('Cohere response does not include float embeddings')
  }

  return embeddings.float
}

function getRerankResults(response: { results: Array<{ index: number; relevanceScore: number }> } | { body: { results: Array<{ index: number; relevanceScore: number }> } }) {
  return 'body' in response ? response.body.results : response.results
}

export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const cohere = createCohereClient()

  const response = await cohere.v2.embed({
    model: EMBEDDING_MODEL,
    inputType: 'search_query',
    embeddingTypes: ['float'],
    outputDimension: EMBEDDING_DIMENSIONS,
    texts: [query],
  })

  const embeddings = getFloatEmbeddings(response)
  const first = embeddings[0]

  if (!first) {
    throw new Error('Failed to generate embedding for query.')
  }

  return first
}

export async function searchByEmbedding(embedding: number[], limit = 30): Promise<RetrievedChunk[]> {
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
    .orderBy(distance)
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    parentUrl: row.parentUrl,
    pageTitle: row.pageTitle,
    chunkText: row.chunkText,
    createdAt: row.createdAt,
    similarity: 1 - Number(row.distance),
  }))
}

export async function rerankChunks(query: string, chunks: RetrievedChunk[], topN = 8): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) {
    return []
  }

  const cohere = createCohereClient()
  const response = await cohere.v2.rerank({
    model: RERANK_MODEL,
    query,
    documents: chunks.map((chunk) => chunk.chunkText),
    topN,
  })

  const results = getRerankResults(response)

  const reranked = results.reduce<RetrievedChunk[]>((accumulator, result) => {
      const chunk = chunks[result.index]
      if (!chunk) {
        return accumulator
      }

      accumulator.push({
        ...chunk,
        rerankScore: result.relevanceScore,
      })

      return accumulator
    }, [])

  const filtered = reranked.filter((chunk) => (chunk.rerankScore ?? 0) >= MIN_RERANK_SCORE)
  const selected = filtered.length > 0 ? filtered : reranked.slice(0, Math.min(2, reranked.length))

  const seen = new Set<string>()
  return selected.filter((chunk) => {
    const signature = chunk.chunkText.slice(0, 220).trim().toLowerCase()
    if (seen.has(signature)) {
      return false
    }

    seen.add(signature)
    return true
  })
}

export async function retrieveRelevantChunks(query: string, candidateLimit = 30, topN = 8): Promise<RetrievedChunk[]> {
  const embedding = await generateQueryEmbedding(query)
  const candidates = await searchByEmbedding(embedding, candidateLimit)

  return rerankChunks(query, candidates, topN)
}

export function buildRagContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return 'No relevant indexed content was found for this question.'
  }

  return chunks
    .map((chunk, index) => {
      const title = chunk.pageTitle?.trim() || 'Untitled page'
      const score = chunk.rerankScore ?? chunk.similarity

      return [
        `Source ${index + 1}`,
        `URL: ${chunk.parentUrl}`,
        `Title: ${title}`,
        `Score: ${score.toFixed(4)}`,
        chunk.chunkText,
      ].join('\n')
    })
    .join('\n\n---\n\n')
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
