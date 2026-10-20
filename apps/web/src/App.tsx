import { useEffect, useState } from 'react'
import './App.css'

type ApiHealth = {
  status: string
  database: string
}

function App() {
  const [health, setHealth] = useState<ApiHealth | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('A API ou o banco ainda não estão disponíveis.')
        }
        return (await response.json()) as ApiHealth
      })
      .then(setHealth)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name === 'AbortError') {
          return
        }
        setError(true)
      })

    return () => controller.abort()
  }, [])

  return (
    <main className="page">
      <section className="welcome-card" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">
          SC
        </div>
        <p className="eyebrow">MVP 1 · Ambiente local</p>
        <h1 id="app-title">Saldo Certo</h1>
        <p className="intro">
          Sua base para organizar entradas, despesas e metas financeiras.
        </p>

        <div className="connection" role="status" aria-live="polite">
          {health ? (
            <>
              <span className="status-dot" />
              API e PostgreSQL conectados
            </>
          ) : error ? (
            <>
              <span className="status-dot status-dot--error" />
              Não foi possível conectar à API
            </>
          ) : (
            <>
              <span className="status-dot status-dot--loading" />
              Verificando API e PostgreSQL…
            </>
          )}
        </div>
      </section>
    </main>
  )
}

export default App
