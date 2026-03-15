import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return (
    <div>
      <h1>Welcome to the Home Page</h1>
      <p>This is a simple home page component.</p>
    </div>
  )
}
