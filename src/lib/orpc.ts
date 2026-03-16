import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

import type { router } from '../../app/api/rpc/[...path]/route'

type AppRouterClient = RouterClient<typeof router>

function getRpcUrl(): string {
  const configured = process.env.NEXT_PUBLIC_RPC_URL?.trim()
  if (configured) {
    return configured
  }

  // In browsers, use the current origin so it works in any environment.
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/api/rpc`
  }

  // Server-side fallback for local/dev contexts.
  const port = process.env.PORT ?? '3000'
  return `http://127.0.0.1:${port}/api/rpc`
}

const RPC_URL = getRpcUrl()

const link = new RPCLink({
  url: RPC_URL,
})

export const rpcClient = createORPCClient<AppRouterClient>(link)
export const orpc = createTanstackQueryUtils(rpcClient)
