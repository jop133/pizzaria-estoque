import { useState, useEffect } from 'react'
import { Toaster } from 'react-hot-toast'
import toast from 'react-hot-toast'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Estoque } from './pages/Estoque'
import { FichasTecnicas } from './pages/FichasTecnicas'
import { Lancamentos } from './pages/Lancamentos'
import { Historico } from './pages/Historico'
import { Relatorios } from './pages/Relatorios'
import { ImportarFoto } from './pages/ImportarFoto'
import { Configuracoes } from './pages/Configuracoes'
import { useProdutosAbaixoMinimo } from './hooks/useEstoque'

const ABAS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'estoque', label: 'Estoque', icon: '📦' },
  { id: 'fichas', label: 'Fichas', icon: '📋' },
  { id: 'lancamentos', label: 'Lançar', icon: '✏️' },
  { id: 'foto', label: 'Foto IA', icon: '📷' },
  { id: 'historico', label: 'Histórico', icon: '🕐' },
  { id: 'relatorios', label: 'Relatórios', icon: '📈' },
  { id: 'config', label: 'Config', icon: '⚙️' },
]

function AppInner() {
  const { user, membro, membros, organizacao, loading, trocarOrg, aceitarConvite } = useAuth()
  const [aba, setAba] = useState('dashboard')
  const abaixoMinimo = useProdutosAbaixoMinimo()

  // Aceitar convite quando o usuário já está logado
  useEffect(() => {
    if (!user || !membro) return
    const params = new URLSearchParams(window.location.search)
    const token = params.get('convite')
    if (!token) return
    aceitarConvite(token)
      .then(() => toast.success('Você entrou na nova organização!'))
      .catch(err => toast.error(err.message))
      .finally(() => window.history.replaceState({}, '', window.location.pathname))
  }, [user, membro]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="min-h-screen bg-red-600 flex items-center justify-center">
        <div className="text-center text-white space-y-3">
          <div className="text-5xl">🍕</div>
          <p className="font-semibold">Carregando...</p>
        </div>
      </div>
    )
  }

  if (!user || !membro) return <Login />

  const renderPage = () => {
    switch (aba) {
      case 'dashboard': return <Dashboard />
      case 'estoque': return <Estoque />
      case 'fichas': return <FichasTecnicas />
      case 'lancamentos': return <Lancamentos />
      case 'historico': return <Historico />
      case 'relatorios': return <Relatorios />
      case 'foto': return <ImportarFoto />
      case 'config': return <Configuracoes />
      default: return <Dashboard />
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-red-600 text-white px-4 py-3 flex items-center gap-3 shadow-md">
        <span className="text-2xl">🍕</span>
        <div>
          <h1 className="font-bold text-lg leading-tight">Pizzaria Estoque</h1>
          {membros.length > 1 ? (
            <select
              value={membro?.organizacao_id || ''}
              onChange={e => trocarOrg(e.target.value)}
              className="bg-red-700 text-white text-xs rounded px-1 py-0.5 mt-0.5 max-w-[160px] focus:outline-none"
            >
              {membros.map(m => (
                <option key={m.organizacao_id} value={m.organizacao_id}>
                  {m.organizacoes?.nome || 'Organização'}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-red-200 text-xs">{organizacao?.nome || 'Controle de estoque'}</p>
          )}
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
            <span className="text-[9px] font-medium">{a.label}</span>
          </button>
        ))}
      </nav>

      <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}
