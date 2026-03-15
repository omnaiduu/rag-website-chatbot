CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_url" text NOT NULL,
	"page_title" text,
	"chunk_text" text NOT NULL,
	"embedding" vector(512),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "embedding_index" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "parent_url_index" ON "document_chunks" USING btree ("parent_url");