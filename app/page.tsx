'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useForm } from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
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
import type { IngestProgressEvent, IngestResult, IngestSourceSummary } from './api/rpc/[...path]/route'
import { rpcClient } from '@/lib/orpc'
import { cn } from '@/lib/utils'

const crawlSchema = z.object({
  url: z.url('Please provide a valid website URL.'),
  maxPages: z.number().int().min(1).max(500),
  depth: z.number().int().min(1).max(3),
})

type CrawlFormValues = z.infer<typeof crawlSchema>
type WebsiteSource = {
  id: string
  url: string
  maxPages?: number
  depth?: number
  createdAt: string
  stats?: {
    visitedPages: number
    pagesWithContent: number
    totalChunks: number
    insertedChunks: number
  }
  indexedPages: string[]
}

type IngestState = {
  status: 'idle' | 'running' | 'done' | 'canceled'
  progress: number
  step: string
}

type LiveIngestStats = {
  visitedPages: number
  queuedPages: number
  pagesWithContent: number
  totalChunks: number
  insertedChunks: number
  pendingChunks: number
  currentUrl?: string
  mode?: IngestProgressEvent['mode']
  lastError?: string
}

const INGEST_STEPS = [
  'Validating URL and crawl options...',
  'Collecting website pages...',
  'Chunking content for retrieval...',
  'Building searchable knowledge index...',
]

const STAGE_LABELS: Record<IngestProgressEvent['stage'], string> = {
  init: 'Initializing crawl',
  crawl: 'Crawling pages',
  extract: 'Extracting content',
  chunk: 'Chunking content',
  embed: 'Generating embeddings',
  store: 'Saving knowledge',
  done: 'Completed',
}

const makeId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

function getFieldError(errors: unknown[]) {
  const first = errors[0]
  return typeof first === 'string' ? first : null
}

function getDomainLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function formatProgressStep(event: IngestProgressEvent) {
  const stageLabel = STAGE_LABELS[event.stage]

  if (event.stage === 'chunk') {
    return `${stageLabel}: ${event.counts.totalChunks} chunks prepared`
  }

  if (event.stage === 'store') {
    return `${stageLabel}: ${event.counts.insertedChunks} chunks indexed`
  }

  return `${stageLabel}: ${event.message}`
}

function toUiSource(source: IngestSourceSummary): WebsiteSource {
  return {
    id: source.origin,
    url: source.rootUrl,
    createdAt: new Date(source.lastIndexedAt).toLocaleString(),
    stats: {
      visitedPages: source.visitedPages,
      pagesWithContent: source.pagesWithContent,
      totalChunks: source.totalChunks,
      insertedChunks: source.insertedChunks,
    },
    indexedPages: source.pageUrls,
  }
}

export default function Page() {
  const [sources, setSources] = useState<WebsiteSource[]>([])
  const [isSourcesLoading, setIsSourcesLoading] = useState(false)
  const [isCanceling, setIsCanceling] = useState(false)
  const [recentIngestEvents, setRecentIngestEvents] = useState<string[]>([])
  const [liveIngestStats, setLiveIngestStats] = useState<LiveIngestStats>({
    visitedPages: 0,
    queuedPages: 0,
    pagesWithContent: 0,
    totalChunks: 0,
    insertedChunks: 0,
    pendingChunks: 0,
  })
  const [ingestState, setIngestState] = useState<IngestState>({
    status: 'idle',
    progress: 0,
    step: 'Ready to add a website.',
  })

  const activeIngestIteratorRef = useRef<AsyncIterator<IngestProgressEvent, IngestResult> | null>(null)
  const ingestCanceledRef = useRef(false)
  const ingestProgressRef = useRef(0)

  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  })

  const isThinking = status === 'submitted' || status === 'streaming'
  const isIngesting = ingestState.status === 'running'

  const ingestMutation = useMutation({
    mutationFn: (input: { rootUrl: string; maxPages: number }) => rpcClient.ingest(input),
  })

  const listSourcesMutation = useMutation({
    mutationFn: () => rpcClient.listIngestSources(),
  })

  const deleteSourceMutation = useMutation({
    mutationFn: (rootUrl: string) => rpcClient.deleteIngest({ rootUrl }),
  })

  const sourceCountLabel = useMemo(() => {
    if (sources.length === 0) return 'No sites indexed yet'
    if (sources.length === 1) return '1 site indexed'
    return `${sources.length} sites indexed`
  }, [sources.length])

  const reloadSources = async () => {
    setIsSourcesLoading(true)

    try {
      const data = await listSourcesMutation.mutateAsync()
      setSources(data.map(toUiSource))
    } catch (error) {
      console.error('Failed to load indexed sources:', error)
    } finally {
      setIsSourcesLoading(false)
    }
  }

  useEffect(() => {
    void reloadSources()
  }, [])

  const crawlForm = useForm({
    defaultValues: { url: '', maxPages: 25, depth: 2 } satisfies CrawlFormValues,
    validators: { onChange: crawlSchema, onSubmit: crawlSchema },
    onSubmit: async ({ value, formApi }) => {
      if (activeIngestIteratorRef.current) return

      const indexedPages = new Set<string>([value.url])

      setIsCanceling(false)
      setRecentIngestEvents([])
      setLiveIngestStats({
        visitedPages: 0,
        queuedPages: 0,
        pagesWithContent: 0,
        totalChunks: 0,
        insertedChunks: 0,
        pendingChunks: 0,
        currentUrl: value.url,
      })
      ingestCanceledRef.current = false
      ingestProgressRef.current = 0
      setIngestState({ status: 'running', progress: 0, step: INGEST_STEPS[0] })

      try {
        const iterator = (await ingestMutation.mutateAsync({
          rootUrl: value.url,
          maxPages: value.maxPages,
        })) as AsyncIterator<IngestProgressEvent, IngestResult>

        activeIngestIteratorRef.current = iterator

        let result: IngestResult | undefined

        while (true) {
          const next = await iterator.next()

          if (next.done) {
            result = next.value
            break
          }

          const event = next.value
          const step = formatProgressStep(event)

          if (event.url) {
            indexedPages.add(event.url)
          }

          setLiveIngestStats({
            visitedPages: event.counts.visitedPages,
            queuedPages: event.counts.queuedPages,
            pagesWithContent: event.counts.pagesWithContent,
            totalChunks: event.counts.totalChunks,
            insertedChunks: event.counts.insertedChunks,
            pendingChunks: event.counts.pendingChunks,
            currentUrl: event.url,
            mode: event.mode,
            lastError: event.error,
          })

          setRecentIngestEvents((current) => {
            const line = `${STAGE_LABELS[event.stage]}: ${event.message}`
            const nextEvents = [line, ...current]
            return nextEvents.slice(0, 8)
          })

          ingestProgressRef.current = event.progress
          setIngestState({ status: 'running', progress: event.progress, step })
        }

        if (ingestCanceledRef.current || result?.stopReason === 'aborted') {
          setIngestState({ status: 'canceled', progress: ingestProgressRef.current, step: 'Indexing canceled. You can restart anytime.' })
          return
        }

        const nextSource: WebsiteSource = {
          id: makeId(),
          url: result?.rootUrl ?? value.url,
          maxPages: value.maxPages,
          depth: value.depth,
          createdAt: new Date().toLocaleString(),
          stats: {
            visitedPages: result?.visitedPages ?? 0,
            pagesWithContent: result?.pagesWithContent ?? 0,
            totalChunks: result?.totalChunks ?? 0,
            insertedChunks: result?.insertedChunks ?? 0,
          },
          indexedPages: [...indexedPages],
        }

        setSources((current) => [nextSource, ...current.filter((item) => item.url !== nextSource.url)])

        setIngestState({ status: 'done', progress: 100, step: 'Knowledge index updated successfully.' })
        void reloadSources()
        formApi.reset()
        formApi.setFieldValue('maxPages', 25)
        formApi.setFieldValue('depth', 2)
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : 'Failed to ingest website.'
        setIngestState({ status: 'idle', progress: 0, step: `Indexing failed: ${message}` })
        setRecentIngestEvents((current) => [`Error: ${message}`, ...current].slice(0, 8))
      } finally {
        setIsCanceling(false)
        activeIngestIteratorRef.current = null
      }
    },
  })

  const cancelIngest = () => {
    setIsCanceling(true)
    ingestCanceledRef.current = true

    const iterator = activeIngestIteratorRef.current
    if (iterator?.return) {
      void iterator.return(undefined as never)
    }

    setIngestState((current) => ({
      ...current,
      status: 'canceled',
      progress: ingestProgressRef.current,
      step: 'Indexing canceled. You can restart anytime.',
    }))
  }

  const sendPrompt = async (message: PromptInputMessage) => {
    const hasText = Boolean(message.text?.trim())
    if (!hasText || isThinking) return

    await sendMessage({ text: message.text?.trim() })
  }

  const handleDeleteSource = async (url: string) => {
    try {
      await deleteSourceMutation.mutateAsync(url)
      await reloadSources()
    } catch (error) {
      console.error('Failed to delete source:', error)
      setIngestState({
        status: 'idle',
        progress: ingestProgressRef.current,
        step: `Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      })
    }
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

              <DialogContent className="h-[88svh] w-full !max-w-[min(1100px,96vw)] overflow-hidden p-0" showCloseButton>
                <div className="grid h-full lg:grid-cols-[1.2fr_1fr]">
                  <section className="min-h-0 space-y-4 overflow-y-auto p-5">
                    <DialogHeader>
                      <DialogTitle className="text-lg">RAG Website Knowledge Panel</DialogTitle>
                      <DialogDescription>Manage crawl sources, monitor indexing, and keep your chatbot grounded with fresh knowledge.</DialogDescription>
                    </DialogHeader>

                    <div className="rounded-xl border border-border/70 bg-card p-4">
                      <p className="font-medium text-sm">Indexed Sources</p>
                      <p className="mb-3 text-xs text-muted-foreground">{isSourcesLoading ? 'Refreshing indexed sources...' : sourceCountLabel}</p>

                      {sources.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No websites indexed yet. Add one from the form.</div>
                      ) : (
                        <ul className="space-y-2">
                          {sources.map((source) => (
                            <li className="rounded-md border border-border/70 bg-muted/35 p-3" key={source.id}>
                              <div className="flex items-start gap-2">
                                <Link2Icon className="mt-0.5 size-3.5 shrink-0" />
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-xs" title={source.url}>{source.url}</p>
                                  <p className="text-[11px] text-muted-foreground">{getDomainLabel(source.url)}{source.maxPages ? ` · max ${source.maxPages} pages` : ''}{source.depth ? ` · depth ${source.depth}` : ''}</p>
                                  {source.stats && <p className="text-[11px] text-muted-foreground">{source.stats.visitedPages} pages visited · {source.stats.pagesWithContent} pages with content · {source.stats.totalChunks} chunks prepared · {source.stats.insertedChunks} chunks indexed</p>}
                                  {source.indexedPages.length > 0 && (
                                    <details className="mt-1">
                                      <summary className="cursor-pointer text-[11px] text-muted-foreground">Indexed pages ({source.indexedPages.length})</summary>
                                      <ul className="mt-1 max-h-28 space-y-1 overflow-auto pr-1">
                                        {source.indexedPages.map((pageUrl) => (
                                          <li className="truncate text-[11px] text-muted-foreground" key={pageUrl} title={pageUrl}>
                                            <a className="hover:underline" href={pageUrl} rel="noreferrer" target="_blank">{pageUrl}</a>
                                          </li>
                                        ))}
                                      </ul>
                                    </details>
                                  )}
                                  <p className="mt-1 text-[11px] text-muted-foreground">Added: {source.createdAt}</p>
                                </div>
                                <Button className="ml-auto" disabled={deleteSourceMutation.isPending} onClick={() => void handleDeleteSource(source.url)} size="icon-xs" type="button" variant="destructive">
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

                  <section className="min-h-0 border-t border-border/70 bg-muted/25 p-5 lg:border-t-0 lg:border-l">
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
                          <Button className="w-full" disabled={!canSubmit || isSubmitting || isIngesting || ingestMutation.isPending} size="sm" type="submit">
                            {isCanceling ? (
                              <span className="inline-flex items-center gap-2">
                                <LoaderCircleIcon className="size-4 animate-spin" />
                                Canceling indexing...
                              </span>
                            ) : isIngesting ? (
                              <span className="inline-flex items-center gap-2">
                                <LoaderCircleIcon className="size-4 animate-spin" />
                                Indexing website...
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
                      <p className="mt-2 text-xs text-muted-foreground">{ingestState.progress}% complete</p>
                      <p className="mt-2 text-xs text-muted-foreground">{ingestState.step}</p>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                        <p>Visited: {liveIngestStats.visitedPages}</p>
                        <p>Queued: {liveIngestStats.queuedPages}</p>
                        <p>Pages with content: {liveIngestStats.pagesWithContent}</p>
                        <p>Pending chunks: {liveIngestStats.pendingChunks}</p>
                        <p>Total chunks: {liveIngestStats.totalChunks}</p>
                        <p>Indexed chunks: {liveIngestStats.insertedChunks}</p>
                      </div>
                      {liveIngestStats.currentUrl && (
                        <p className="mt-2 truncate text-[11px] text-muted-foreground" title={liveIngestStats.currentUrl}>
                          Current URL: {liveIngestStats.currentUrl}
                        </p>
                      )}
                      {liveIngestStats.mode && <p className="mt-1 text-[11px] text-muted-foreground">Scrape mode: {liveIngestStats.mode}</p>}
                      {liveIngestStats.lastError && <p className="mt-1 text-[11px] text-destructive">Last crawl issue: {liveIngestStats.lastError}</p>}
                      {recentIngestEvents.length > 0 && (
                        <div className="mt-2 rounded-md border border-border/70 bg-muted/25 p-2">
                          <p className="text-[11px] font-medium text-foreground">Recent activity</p>
                          <ul className="mt-1 max-h-24 space-y-1 overflow-auto">
                            {recentIngestEvents.map((event, index) => (
                              <li className="text-[11px] text-muted-foreground" key={`${event}-${index}`}>{event}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {isIngesting && (
                        <div className="mt-2">
                          <Shimmer className="text-xs" duration={1.5}>{`Live update: ${ingestState.step} (${ingestState.progress}%)`}</Shimmer>
                        </div>
                      )}
                    </div>

                    <DialogFooter className="mt-4" showCloseButton={false}>
                      <Button disabled={!isIngesting || isCanceling} onClick={cancelIngest} type="button" variant="outline">{isCanceling ? 'Canceling...' : 'Cancel Indexing'}</Button>
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
                <ConversationEmptyState title="Your RAG workspace is ready" description="Add a website in Knowledge Panel, wait for indexing, then ask grounded questions." />
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
                    <Shimmer className="text-sm" duration={1.6}>Retrieving indexed context and preparing a grounded answer...</Shimmer>
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
