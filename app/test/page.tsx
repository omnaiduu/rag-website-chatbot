'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useState } from 'react'

export default function TestPage() {
  const [input, setInput] = useState('')
  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      fetch: (url, init) => {
        console.log('Sending request to /api/chat with body:', init?.body)
        return fetch(url, init)
      },
    }),
  })

  return (
    <div className="mx-auto flex w-full max-w-md flex-col py-24">
      {messages.map((message) => (
        <div key={message.id} className="whitespace-pre-wrap">
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.parts.map((part, i) => {
            switch (part.type) {
              case 'text':
                return <div key={`${message.id}-${i}`}>{part.text}</div>
              default:
                return null
            }
          })}
        </div>
      ))}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void sendMessage({ text: input })
          setInput('')
        }}
      >
        <input
          className="fixed bottom-0 mb-8 w-full max-w-md rounded border border-zinc-300 p-2 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
          value={input}
          placeholder="Say something..."
          onChange={(event) => setInput(event.currentTarget.value)}
        />
      </form>
    </div>
  )
}
