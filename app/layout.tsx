import type { Metadata } from 'next'
import { Geist } from 'next/font/google'

import './globals.css'
import { Providers } from './providers'

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
})


export const metadata: Metadata = {
  title: 'RAG Website Chatbot',
  description: 'Ingest website content and chat with grounded answers.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>

      </head>
      <body className={`${geist.variable} font-sans antialiased [overflow-wrap:anywhere] selection:bg-[rgba(79,184,178,0.24)]`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
