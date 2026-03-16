import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

import type { router } from '../../app/api/rpc/[...path]/route'

type AppRouterClient = RouterClient<typeof router>

function getRpcUrl() {
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/api/rpc`
  }

  return `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/rpc`
}

const link = new RPCLink({
  url: getRpcUrl(),
})

export const rpcClient = createORPCClient<AppRouterClient>(link)
export const orpc = createTanstackQueryUtils(rpcClient)
