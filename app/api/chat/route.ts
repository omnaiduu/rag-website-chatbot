import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { convertToModelMessages, streamText, type UIMessage } from 'ai'

import { getRagContextForQuery } from '@/services/rag'

const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant'

function resolveApiKey(...values: Array<string | undefined>) {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized && !normalized.startsWith('$')) {
      return normalized
    }
  }

  return undefined
}

function getGroqApiKey() {
  return resolveApiKey(process.env.groq, process.env.GROQ_API_KEY)
}

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json()

  const groqApiKey = getGroqApiKey()

  if (!groqApiKey) {
    return Response.json({ error: 'Missing Groq API key. Set GROQ_API_KEY or groq in your environment.' }, { status: 500 })
  }

  const groq = createOpenAICompatible({
    name: 'groq',
    apiKey: groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  })

  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  const userText =
    lastUserMessage?.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim() ?? ''

  let ragContext = 'No relevant indexed content was found for this question.'

  if (userText) {
    try {
      const rag = await getRagContextForQuery(userText, 30, 8)
      ragContext = rag.context
    } catch (error) {
      console.error('RAG retrieval failed:', error)
      ragContext = 'Retrieval failed for this request. Answer with caution and mention missing context explicitly.'
    }
  }

  const result = streamText({
    model: groq(process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL),
    system: `You are a concise RAG website assistant. Answer clearly and avoid making up facts. If context is missing, say what is missing.

Use the retrieved context first. If the answer is not present in context, state that clearly.

Retrieved context:
${ragContext}`,
  messages: await convertToModelMessages(messages),
  })

  return result.toUIMessageStreamResponse()
}
