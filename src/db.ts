
import { drizzle } from 'drizzle-orm/postgres-js'
import { env } from '@/env'

function withRequiredSsl(url: string): string {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('sslmode')) {
        parsed.searchParams.set('sslmode', 'require');
    }
    return parsed.toString();
}

export const db = drizzle(withRequiredSsl(env.DATABASE_URL));