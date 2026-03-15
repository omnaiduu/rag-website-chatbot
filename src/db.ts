
import { drizzle } from 'drizzle-orm/postgres-js'

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.');
}

function withRequiredSsl(url: string): string {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('sslmode')) {
        parsed.searchParams.set('sslmode', 'require');
    }
    return parsed.toString();
}

export const db = drizzle(withRequiredSsl(databaseUrl));