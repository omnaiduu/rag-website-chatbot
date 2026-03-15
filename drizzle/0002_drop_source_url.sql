DROP INDEX IF EXISTS "source_url_index";
--> statement-breakpoint
ALTER TABLE "document_chunks" DROP COLUMN IF EXISTS "source_url";
