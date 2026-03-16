import type { UIMessage } from 'ai'

export type ChatMessageSource = {
    url: string
    title: string
    score: number
    excerpt: string
}

export type ChatMessageMetadata = {
    createdAt?: number
    model?: string
    totalTokens?: number
    sourceCount?: number
    sources?: ChatMessageSource[]
}

export type ChatUIMessage = UIMessage<ChatMessageMetadata>
