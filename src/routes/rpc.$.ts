import { RPCHandler } from '@orpc/server/fetch'
import { createFileRoute } from '@tanstack/react-router'
import { onError, os } from '@orpc/server'


const ingest = os.handler(async () => {

    console.log('Ingesting data...')
    return { message: 'Data received successfully' }
})
const deleteIngest = os.handler(async () => {

    console.log('Deleting ingested data...')
    return { message: 'Data deleted successfully' }
})


export const router = {
    ingest,
    deleteIngest,
}

const handler = new RPCHandler(router, {
    interceptors: [
        onError((error) => {
            console.error(error)
        }),
    ],
})

export const Route = createFileRoute('/rpc/$')({
    server: {
        handlers: {
            ANY: async ({ request }) => {
                const { response } = await handler.handle(request, {
                    prefix: '/rpc',
                    context: {}, // Provide initial context if needed
                })

                return response ?? new Response('Not Found', { status: 404 })
            },
        },
    },
})