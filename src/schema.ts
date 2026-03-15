import { index, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';

export const documentChunks = pgTable('document_chunks', {
    id: uuid('id').defaultRandom().primaryKey(),

    parentUrl: text('parent_url').notNull(),
    pageTitle: text('page_title'),
    chunkText: text('chunk_text').notNull(),

    // Matryoshka embeddings optimized for the reranker pipeline
    embedding: vector('embedding', { dimensions: 512 }),

    createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
    // 1. The HNSW Vector Index
    // We use 'vector_cosine_ops' as the distance operator, which is standard for Cohere/OpenAI embeddings
    index('embedding_index').using('hnsw', table.embedding.op('vector_cosine_ops')),

    // 2. The Deletion/UI Index
    // Speeds up the query: DELETE FROM document_chunks WHERE parent_url = '...'
    index('parent_url_index').on(table.parentUrl)
]);