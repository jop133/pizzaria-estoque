import { useState, useEffect } from 'react'
import { Toaster } from 'react-hot-toast'
import toast from 'react-hot-toast'
import {
  Home, Package, PencilLine, Camera, History,
  ClipboardList, BarChart3, Settings, LogOut, Menu, AlertTriangle, ShoppingCart, ClipboardCheck,
} from 'lucide-react'
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
import { ListaCompras } from './pages/ListaCompras'
import { ContagemEstoque } from './pages/ContagemEstoque'
import { useProdutosAbaixoMinimo } from './hooks/useEstoque'

// Definição central das telas
const ABAS = {
  dashboard: { label: 'Início', Icon: Home },
  estoque: { label: 'Estoque', Icon: Package },
  compras: { label: 'Lista de Compras', Icon: ShoppingCart },
  lancamentos: { label: 'Lançar', Icon: PencilLine },
  foto: { label: 'Foto IA', Icon: Camera },
  historico: { label: 'Histórico', Icon: History },
  fichas: { label: 'Fichas Técnicas', Icon: ClipboardList },
  contagem: { label: 'Contagem', Icon: ClipboardCheck },
  relatorios: { label: 'Relatórios', Icon: BarChart3 },
  config: { label: 'Configurações', Icon: Settings },
}

// Grupos exibidos no menu lateral
const GRUPOS = [
  { titulo: 'Principal', itens: ['dashboard', 'estoque', 'compras', 'lancamentos', 'foto', 'historico'] },
  { titulo: 'Gestão', itens: ['fichas', 'contagem', 'relatorios'] },
  { titulo: 'Conta', itens: ['config'] },
]

function AppInner() {
  const { user, membro, membros, organizacao, loading, trocarOrg, aceitarConvite, logout } = useAuth()
  const [aba, setAba] = useState('dashboard')
  const [menuAberto, setMenuAberto] = useState(false)
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
      <div className="min-h-screen bg-red-800 flex items-center justify-center">
        <div className="text-center text-white space-y-3">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-white shadow-lg overflow-hidden animate-pulse">
            <img src="/logo.png" alt="" className="w-16 h-16 object-contain" />
          </div>
          <p className="font-semibold">Carregando...</p>
        </div>
      </div>
    )
  }

  if (!user || !membro) return <Login />

  function irPara(id) {
    setAba(id)
    setMenuAberto(false)
  }

  const renderPage = () => {
    switch (aba) {
      case 'dashboard': return <Dashboard />
      case 'estoque': return <Estoque />
      case 'compras': return <ListaCompras />
      case 'fichas': return <FichasTecnicas />
      case 'contagem': return <ContagemEstoque />
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
      {/* Cabeçalho */}
      <header className="bg-red-800 text-white px-3 py-3 flex items-center gap-2 shadow-md sticky top-0 z-30">
        <button
          onClick={() => setMenuAberto(true)}
          className="p-2 -ml-1 rounded-lg hover:bg-red-700 active:bg-red-900 transition-colors"
          aria-label="Abrir menu"
        >
          <Menu className="w-6 h-6" />
        </button>
        <img src="/logo.png" alt="" className="w-9 h-9 rounded-md bg-white object-contain p-0.5 shrink-0" />
        <div className="min-w-0">
          <h1 className="font-bold text-base leading-tight truncate">{ABAS[aba]?.label || 'Pizzaria Estoque'}</h1>
          <p className="text-red-200 text-xs truncate">{organizacao?.nome || 'Controle de estoque'}</p>
        </div>
        {abaixoMinimo.length > 0 && (
          <button
            onClick={() => setAba('compras')}
            className="ml-auto flex items-center gap-1 bg-red-600 hover:bg-red-500 text-white text-xs font-bold px-3 py-1.5 rounded-full animate-pulse shrink-0"
          >
            <AlertTriangle className="w-3.5 h-3.5" /> {abaixoMinimo.length}
          </button>
        )}
      </header>

      {/* Conteúdo */}
      <main className="flex-1 p-4 pb-24 max-w-4xl mx-auto w-full">
        {renderPage()}
      </main>

      {/* Menu lateral (drawer) */}
      <div className={`fixed inset-0 z-50 ${menuAberto ? '' : 'pointer-events-none'}`}>
        <div
          onClick={() => setMenuAberto(false)}
          className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${menuAberto ? 'opacity-100' : 'opacity-0'}`}
        />
        <aside
          className={`absolute left-0 top-0 h-full w-72 max-w-[82vw] bg-white shadow-2xl flex flex-col transition-transform duration-200 ${menuAberto ? 'translate-x-0' : '-translate-x-full'}`}
        >
          {/* Topo do menu */}
          <div className="bg-red-800 text-white p-4">
            <div className="flex items-center">
              <img src="/logo.png" alt="Pier Pizza & Cantina" className="w-12 h-12 rounded-md bg-white object-contain p-0.5" />
            </div>
            {membros.length > 1 ? (
              <select
                value={membro?.organizacao_id || ''}
                onChange={e => trocarOrg(e.target.value)}
                className="mt-3 w-full bg-red-700 text-white text-sm rounded-lg px-2 py-1.5 focus:outline-none"
              >
                {membros.map(m => (
                  <option key={m.organizacao_id} value={m.organizacao_id}>
                    {m.organizacoes?.nome || 'Organização'}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-red-200 text-sm mt-1 truncate">{organizacao?.nome}</p>
            )}
          </div>

          {/* Navegação agrupada */}
          <nav className="flex-1 overflow-y-auto py-2">
            {GRUPOS.map(grupo => (
              <div key={grupo.titulo} className="mb-1">
                <p className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">{grupo.titulo}</p>
                {grupo.itens.map(id => {
                  const Icon = ABAS[id].Icon
                  return (
                    <button
                      key={id}
                      onClick={() => irPara(id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                        aba === id
                          ? 'bg-red-50 text-red-700 font-semibold border-r-4 border-red-600'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <Icon className="w-5 h-5 shrink-0" />
                      <span className="text-sm">{ABAS[id].label}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          {/* Rodapé do menu */}
          <div className="border-t border-gray-100 p-3">
            <button
              onClick={() => { setMenuAberto(false); logout() }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <LogOut className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">Sair</span>
            </button>
          </div>
        </aside>
      </div>

      {/* Barra inferior — indicador da tela atual (toque abre o menu) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-40 pb-[env(safe-area-inset-bottom)]">
        <button
          onClick={() => setMenuAberto(true)}
          className="w-full flex items-center justify-center gap-2 py-3 text-red-800 active:bg-red-50 transition-colors"
          aria-label="Abrir menu de navegação"
        >
          {(() => { const Icon = ABAS[aba]?.Icon; return Icon ? <Icon className="w-5 h-5" /> : null })()}
          <span className="text-sm font-semibold">{ABAS[aba]?.label}</span>
        </button>
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
