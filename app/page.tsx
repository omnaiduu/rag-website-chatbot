'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useForm } from '@tanstack/react-form'
import { BotIcon, GlobeIcon, Link2Icon, LoaderCircleIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const crawlSchema = z.object({
  url: z.url('Please provide a valid website URL.'),
  maxPages: z.number().int().min(1).max(500),
  depth: z.number().int().min(1).max(3),
})

type CrawlFormValues = z.infer<typeof crawlSchema>
type WebsiteSource = CrawlFormValues & { id: string; createdAt: string }

type IngestState = {
  status: 'idle' | 'running' | 'done' | 'canceled'
  progress: number
  step: string
}

const KNOWLEDGE_LINKS = [
  'https://docs.tanstack.com/router/latest',
  'https://sdk.vercel.ai/docs',
  'https://ui.shadcn.com/docs/components/dialog',
]

const INGEST_STEPS = [
  'Validating URL and crawl options...',
  'Collecting website pages...',
  'Chunking content for retrieval...',
  'Building searchable knowledge index...',
]

const makeId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

function getFieldError(errors: unknown[]) {
  const first = errors[0]
  return typeof first === 'string' ? first : null
}

export default function Page() {
  const [sources, setSources] = useState<WebsiteSource[]>([])
  const [ingestState, setIngestState] = useState<IngestState>({
    status: 'idle',
    progress: 0,
    step: 'Ready to add a website.',
  })

  const ingestIntervalRef = useRef<number | null>(null)

  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  })

  const isThinking = status === 'submitted' || status === 'streaming'
  const isIngesting = ingestState.status === 'running'

  const sourceCountLabel = useMemo(() => {
    if (sources.length === 0) return 'No sites indexed yet'
    if (sources.length === 1) return '1 site indexed'
    return `${sources.length} sites indexed`
  }, [sources.length])

  useEffect(() => {
    return () => {
      if (ingestIntervalRef.current) {
        window.clearInterval(ingestIntervalRef.current)
      }
    }
  }, [])

  const crawlForm = useForm({
    defaultValues: { url: '', maxPages: 25, depth: 2 } satisfies CrawlFormValues,
    validators: { onChange: crawlSchema, onSubmit: crawlSchema },
    onSubmit: async ({ value, formApi }) => {
      if (ingestIntervalRef.current) return

      let progress = 0
      let stepIndex = 0
      setIngestState({ status: 'running', progress, step: INGEST_STEPS[stepIndex] })

      ingestIntervalRef.current = window.setInterval(() => {
        progress = Math.min(100, progress + Math.floor(Math.random() * 14 + 8))
        stepIndex = Math.min(INGEST_STEPS.length - 1, Math.floor((progress / 100) * INGEST_STEPS.length))
        setIngestState({ status: 'running', progress, step: INGEST_STEPS[stepIndex] })

        if (progress >= 100) {
          if (ingestIntervalRef.current) {
            window.clearInterval(ingestIntervalRef.current)
            ingestIntervalRef.current = null
          }

          setSources((current) => [
            {
              id: makeId(),
              url: value.url,
              maxPages: value.maxPages,
              depth: value.depth,
              createdAt: new Date().toLocaleString(),
            },
            ...current,
          ])

          setIngestState({ status: 'done', progress: 100, step: 'Knowledge index updated successfully.' })
          formApi.reset()
          formApi.setFieldValue('maxPages', 25)
          formApi.setFieldValue('depth', 2)
        }
      }, 500)
    },
  })

  const cancelIngest = () => {
    if (ingestIntervalRef.current) {
      window.clearInterval(ingestIntervalRef.current)
      ingestIntervalRef.current = null
    }

    setIngestState((current) => ({ ...current, status: 'canceled', step: 'Indexing canceled. You can restart anytime.' }))
  }

  const sendPrompt = async (message: PromptInputMessage) => {
    const hasText = Boolean(message.text?.trim())
    if (!hasText || isThinking) return

    await sendMessage({ text: message.text?.trim() })
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-border/70 bg-background/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-muted p-1.5 text-foreground">
              <GlobeIcon className="size-4" />
            </div>
            <div>
              <p className="font-semibold text-sm">RAG Website Chatbot</p>
              <p className="text-xs text-muted-foreground">Live chat is enabled. Manage knowledge from the panel.</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1 text-xs text-muted-foreground md:flex">
              <BotIcon className="size-3.5" />
              Web retrieval assistant
            </div>

            <Dialog>
              <DialogTrigger asChild>
                <button className={buttonVariants({ size: 'sm', variant: 'outline' })} type="button">
                  Knowledge Panel
                </button>
              </DialogTrigger>

              <DialogContent className="h-[88svh] max-w-[min(1100px,96vw)] overflow-hidden p-0" showCloseButton>
                <div className="grid h-full md:grid-cols-[1.2fr_1fr]">
                  <section className="min-h-0 space-y-4 overflow-y-auto p-5">
                    <DialogHeader>
                      <DialogTitle className="text-lg">RAG Website Knowledge Panel</DialogTitle>
                      <DialogDescription>Manage crawl sources, monitor indexing, and keep your chatbot grounded with fresh knowledge.</DialogDescription>
                    </DialogHeader>

                    <div className="rounded-xl border border-border/70 bg-card p-4">
                      <p className="font-medium text-sm">Reference Links</p>
                      <p className="mt-1 text-xs text-muted-foreground">Demo links currently shown in your panel.</p>
                      <ul className="mt-3 space-y-2">
                        {KNOWLEDGE_LINKS.map((link) => (
                          <li className="rounded-md border border-border/70 bg-muted/35 p-2" key={link}>
                            <a className="text-xs text-foreground underline-offset-4 hover:underline" href={link} rel="noreferrer" target="_blank">{link}</a>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-xl border border-border/70 bg-card p-4">
                      <p className="font-medium text-sm">Indexed Sources</p>
                      <p className="mb-3 text-xs text-muted-foreground">{sourceCountLabel}</p>

                      {sources.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No websites indexed yet. Add one from the form.</div>
                      ) : (
                        <ul className="space-y-2">
                          {sources.map((source) => (
                            <li className="rounded-md border border-border/70 bg-muted/35 p-3" key={source.id}>
                              <div className="flex items-start gap-2">
                                <Link2Icon className="mt-0.5 size-3.5 shrink-0" />
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-xs">{source.url}</p>
                                  <p className="text-[11px] text-muted-foreground">max {source.maxPages} pages, depth {source.depth}</p>
                                  <p className="mt-1 text-[11px] text-muted-foreground">Added: {source.createdAt}</p>
                                </div>
                                <Button className="ml-auto" onClick={() => setSources((current) => current.filter((item) => item.id !== source.id))} size="icon-xs" type="button" variant="destructive">
                                  <Trash2Icon className="size-3.5" />
                                  <span className="sr-only">Delete URL</span>
                                </Button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </section>

                  <section className="min-h-0 border-t border-border/70 bg-muted/25 p-5 md:border-t-0 md:border-l">
                    <form
                      className="space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void crawlForm.handleSubmit()
                      }}
                    >
                      <p className="font-medium text-sm">Add Crawl Job</p>

                      <crawlForm.Field name="url">
                        {(field) => {
                          const error = getFieldError(field.state.meta.errors)
                          return (
                            <div className="space-y-1">
                              <Input aria-invalid={Boolean(error)} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} placeholder="https://example.com" value={field.state.value} />
                              {error && <p className="text-[11px] text-destructive">{error}</p>}
                            </div>
                          )
                        }}
                      </crawlForm.Field>

                      <div className="grid grid-cols-2 gap-2">
                        <crawlForm.Field name="maxPages">
                          {(field) => {
                            const error = getFieldError(field.state.meta.errors)
                            return (
                              <div className="space-y-1">
                                <Input aria-invalid={Boolean(error)} max={500} min={1} onBlur={field.handleBlur} onChange={(event) => field.handleChange(Number.parseInt(event.target.value, 10) || 1)} type="number" value={field.state.value} />
                                {error && <p className="text-[11px] text-destructive">{error}</p>}
                              </div>
                            )
                          }}
                        </crawlForm.Field>

                        <crawlForm.Field name="depth">
                          {(field) => {
                            const error = getFieldError(field.state.meta.errors)
                            return (
                              <div className="space-y-1">
                                <select aria-invalid={Boolean(error)} className={cn('h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50', error && 'border-destructive')} onBlur={field.handleBlur} onChange={(event) => field.handleChange(Number(event.target.value))} value={String(field.state.value)}>
                                  <option value="1">Depth 1</option>
                                  <option value="2">Depth 2</option>
                                  <option value="3">Depth 3</option>
                                </select>
                                {error && <p className="text-[11px] text-destructive">{error}</p>}
                              </div>
                            )
                          }}
                        </crawlForm.Field>
                      </div>

                      <crawlForm.Subscribe selector={(state) => [state.isSubmitting, state.canSubmit]}>
                        {([isSubmitting, canSubmit]) => (
                          <Button className="w-full" disabled={!canSubmit || isSubmitting || isIngesting} size="sm" type="submit">
                            {isIngesting ? (
                              <span className="inline-flex items-center gap-2">
                                <LoaderCircleIcon className="size-4 animate-spin" />
                                Indexing demo data...
                              </span>
                            ) : (
                              'Start Indexing'
                            )}
                          </Button>
                        )}
                      </crawlForm.Subscribe>
                    </form>

                    <div className="mt-4 rounded-xl border border-border/70 bg-card p-3">
                      <p className="font-medium text-xs uppercase">Live Progress</p>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-foreground/80 transition-all" style={{ width: `${Math.max(3, ingestState.progress)}%` }} />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">{ingestState.step}</p>
                      {isIngesting && (
                        <div className="mt-2">
                          <Shimmer className="text-xs" duration={1.5}>{`Crawling pages and building embeddings (${ingestState.progress}%)...`}</Shimmer>
                        </div>
                      )}
                    </div>

                    <DialogFooter className="mt-4" showCloseButton={false}>
                      <Button disabled={!isIngesting} onClick={cancelIngest} type="button" variant="outline">Cancel Indexing</Button>
                      <DialogClose asChild>
                        <Button type="button">Close Panel</Button>
                      </DialogClose>
                    </DialogFooter>
                  </section>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col gap-3 px-3 py-3 md:px-6 md:py-4">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card">
          <Conversation className="h-full">
            <ConversationContent className="gap-5 p-4 md:p-6">
              {messages.length === 0 ? (
                <ConversationEmptyState title="Your RAG workspace is ready" description="Open Knowledge Panel and add a website, then ask a question." />
              ) : (
                messages.map((message) => (
                  <Message from={message.role} key={message.id}>
                    <MessageContent>
                      {message.parts.map((part, index) => {
                        if (part.type !== 'text') return null
                        return <MessageResponse key={`${message.id}-${index}`}>{part.text}</MessageResponse>
                      })}
                    </MessageContent>
                  </Message>
                ))
              )}

              {isThinking && (
                <Message from="assistant">
                  <MessageContent>
                    <Shimmer className="text-sm" duration={1.6}>Searching indexed pages and preparing a grounded answer...</Shimmer>
                  </MessageContent>
                </Message>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>

        <PromptInput className="rounded-xl border border-border/70 bg-card p-3 md:p-4" onSubmit={(message) => void sendPrompt(message)} onSubmitCapture={(event) => event.preventDefault()}>
          <PromptInputBody>
            <PromptInputTextarea maxLength={1500} placeholder="What does the pricing page say about enterprise plans?" />
          </PromptInputBody>

          <PromptInputFooter>
            <PromptInputTools />

            <PromptInputSubmit onStop={() => void stop()} status={status} />
          </PromptInputFooter>
        </PromptInput>
      </main>
    </div>
  )
}
