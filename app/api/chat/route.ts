import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { convertToModelMessages, streamText, type UIMessage } from 'ai'

const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'

const groq = createOpenAICompatible({
  name: 'groq',
  apiKey: process.env.groq,
  baseURL: 'https://api.groq.com/openai/v1',
})

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json()

  if (!process.env.groq) {
    return Response.json({ error: 'Missing GROQ_API_KEY in environment.' }, { status: 500 })
  }

  const result = streamText({
    model: groq(process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL),
    system:
      'You are a concise RAG website assistant. Answer clearly and avoid making up facts. If context is missing, say what is missing.',
    messages: await convertToModelMessages(messages),
  })

  return result.toUIMessageStreamResponse()
}
