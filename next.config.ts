import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    '127.0.0.1',
    'localhost',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ],
  turbopack: {},
}

export default nextConfig
