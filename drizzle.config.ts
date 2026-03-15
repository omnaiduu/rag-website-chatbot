import { defineConfig } from "drizzle-kit";
import "dotenv/config";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Add it to your .env file.");
}

function withRequiredSsl(url: string): string {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("sslmode")) {
        parsed.searchParams.set("sslmode", "require");
    }
    return parsed.toString();
}

export default defineConfig({
    out: './drizzle',
    schema: './src/schema.ts',
    dialect: "postgresql",
    dbCredentials: {
        url: withRequiredSsl(databaseUrl)
    },
});

