import { useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { Dashboard } from './pages/Dashboard'
import { Estoque } from './pages/Estoque'
import { FichasTecnicas } from './pages/FichasTecnicas'
import { Lancamentos } from './pages/Lancamentos'
import { Historico } from './pages/Historico'
import { Relatorios } from './pages/Relatorios'
import { ImportarFoto } from './pages/ImportarFoto'
import { useProdutosAbaixoMinimo } from './hooks/useEstoque'

const ABAS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'estoque', label: 'Estoque', icon: '📦' },
  { id: 'fichas', label: 'Fichas', icon: '📋' },
  { id: 'lancamentos', label: 'Lançar', icon: '✏️' },
  { id: 'foto', label: 'Foto IA', icon: '📷' },
  { id: 'historico', label: 'Histórico', icon: '🕐' },
  { id: 'relatorios', label: 'Relatórios', icon: '📈' },
]

export default function App() {
  const [aba, setAba] = useState('dashboard')
  const abaixoMinimo = useProdutosAbaixoMinimo()

  const renderPage = () => {
    switch (aba) {
      case 'dashboard': return <Dashboard />
      case 'estoque': return <Estoque />
      case 'fichas': return <FichasTecnicas />
      case 'lancamentos': return <Lancamentos />
      case 'historico': return <Historico />
      case 'relatorios': return <Relatorios />
      case 'foto': return <ImportarFoto />
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-red-600 text-white px-4 py-3 flex items-center gap-3 shadow-md">
        <span className="text-2xl">🍕</span>
        <div>
          <h1 className="font-bold text-lg leading-tight">Pizzaria Estoque</h1>
          <p className="text-red-200 text-xs">Controle de estoque</p>
        </div>
        {abaixoMinimo.length > 0 && (
          <button
            onClick={() => setAba('estoque')}
            className="ml-auto bg-red-500 hover:bg-red-400 text-white text-xs font-bold px-3 py-1.5 rounded-full animate-pulse"
          >
            ⚠️ {abaixoMinimo.length} item{abaixoMinimo.length > 1 ? 's' : ''} baixo
          </button>
        )}
      </header>

      <main className="flex-1 p-4 pb-24 max-w-4xl mx-auto w-full">
        {renderPage()}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex shadow-lg z-40">
        {ABAS.map(a => (
          <button
            key={a.id}
            onClick={() => setAba(a.id)}
            className={`flex-1 flex flex-col items-center py-2 gap-0.5 transition-colors ${
              aba === a.id ? 'text-red-600' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            <span className="text-lg leading-none">{a.icon}</span>
            <span className="text-[10px] font-medium">{a.label}</span>
          </button>
        ))}
      </nav>

      <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
    </div>
  )
}
