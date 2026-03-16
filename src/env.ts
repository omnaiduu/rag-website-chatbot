import { z } from 'zod'

const envSchema = z.object({
    DATABASE_URL: z.string().min(1),
    GROQ_API_KEY: z.string().min(1),
    COHERE_API_KEY: z.string().min(1),
    GROQ_MODEL: z.string().min(1).optional(),
})

export const env = envSchema.parse(process.env)
