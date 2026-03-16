import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { convertToModelMessages, generateText, streamText } from 'ai'

import { env } from '@/env'
import { getRagContextForQuery } from '@/services/rag'
import type { ChatMessageSource, ChatUIMessage } from '@/types/chat'

const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant'
const MAX_HISTORY_MESSAGES = 8
const RETRIEVAL_CONTEXT_TURNS = 4

function getMessageText(message: ChatUIMessage): string {
  return (
    message.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim() ?? ''
  )
}

function buildRetrievalConversationWindow(messages: ChatUIMessage[]): string {
  const textTurns = messages
    .map((message) => ({ role: message.role, text: getMessageText(message) }))
    .filter((turn) => turn.text.length > 0)
    .slice(-RETRIEVAL_CONTEXT_TURNS)

  return textTurns.map((turn) => `${turn.role.toUpperCase()}: ${turn.text}`).join('\n\n')
}

async function rewriteRetrievalQuery(params: {
  groqModel: ReturnType<ReturnType<typeof createOpenAICompatible>>
  userText: string
  conversationWindow: string
}): Promise<string> {
  const { groqModel, userText, conversationWindow } = params

  const { text } = await generateText({
    model: groqModel,
    temperature: 0,
    maxOutputTokens: 64,
    system: 'Rewrite the user query into one standalone retrieval query. Resolve pronouns using recent conversation. Keep key entities (people, places, products, dates). Return only the rewritten query text on one line.',
    prompt: [
      'Recent conversation context:',
      conversationWindow || '(none)',
      '',
      `Latest user query: ${userText}`,
      '',
      'Output one compact standalone retrieval query.',
    ].join('\n'),
  })

  return text.replace(/\s+/g, ' ').trim()
}

export async function POST(request: Request) {
  const { messages }: { messages: ChatUIMessage[] } = await request.json()
  const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES)

  const groq = createOpenAICompatible({
    name: 'groq',
    apiKey: env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  })

  const lastUserMessage = [...recentMessages].reverse().find((message) => message.role === 'user')
  const userText = lastUserMessage ? getMessageText(lastUserMessage) : ''
  const conversationWindow = buildRetrievalConversationWindow(recentMessages)
  let retrievalQuery = userText

  if (userText) {
    try {
      const rewritten = await rewriteRetrievalQuery({
        groqModel: groq(DEFAULT_GROQ_MODEL),
        userText,
        conversationWindow,
      })

      if (rewritten) {
        retrievalQuery = rewritten
      }
    } catch (error) {
      console.warn('Retrieval query rewrite failed, using raw user query:', error)
    }
  }

  let ragContext = 'No relevant indexed content was found for this question.'
  let ragSources: ChatMessageSource[] = []

  if (retrievalQuery) {
    try {
      console.log('RAG retrieval query', { userText, retrievalQuery })
      const rag = await getRagContextForQuery(retrievalQuery, 50, 8)
      console.log('RAG context retrieved')
      ragContext = rag.context
      ragSources = rag.chunks.slice(0, 6).map((chunk) => ({
        url: chunk.parentUrl,
        title: chunk.pageTitle?.trim() || 'Untitled page',
        score: chunk.rerankScore ?? chunk.similarity,
        excerpt: chunk.chunkText.slice(0, 220).trim(),
      }))
    } catch (error) {
      console.error('RAG retrieval failed:', error)
      ragContext = 'Retrieval failed for this request. Answer with caution and mention missing context explicitly.'
      ragSources = []
    }
  }

  const modelId = env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL

  const result = streamText({
    model: groq(modelId),
    system: `You are a concise RAG website assistant. Answer clearly and avoid making up facts. If context is missing, say what is missing.

Use the retrieved context first. If the answer is not present in context, state that clearly.

Retrieved context:
${ragContext}`,
    messages: await convertToModelMessages(recentMessages),
  })
  console.log('Model response initiated')

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    messageMetadata: ({ part }) => {
      if (part.type === 'start') {
        return {
          createdAt: Date.now(),
          model: modelId,
          sourceCount: ragSources.length,
          sources: ragSources,
        }
      }

      if (part.type === 'finish') {
        return {
          model: modelId,
          totalTokens: part.totalUsage.totalTokens,
          sourceCount: ragSources.length,
          sources: ragSources,
        }
      }
    },
  })
}
