import type { RouterClient } from '@orpc/server'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { router } from './routes/rpc.$'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
const link = new RPCLink({
    url: '/rpc',

})

export const orpcClient: RouterClient<typeof router> = createORPCClient(link)
export const orpc = createTanstackQueryUtils(orpcClient)