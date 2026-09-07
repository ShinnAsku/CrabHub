import MainLayout from '@/components/MainLayout'
import ErrorBoundary from '@/components/ErrorBoundary'
import WebAuthGate from '@/components/WebAuthGate'
import { useEffect } from 'react'
import { observeConnectionLifecycle } from '@/app/connection-lifecycle'

function App() {
  useEffect(observeConnectionLifecycle, [])
  return (
    <ErrorBoundary>
      <WebAuthGate>
        <MainLayout />
      </WebAuthGate>
    </ErrorBoundary>
  )
}

export default App
