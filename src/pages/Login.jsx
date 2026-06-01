import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import toast from 'react-hot-toast'

export function Login() {
  const { login, registrar, entrarPorConvite } = useAuth()
  const [modo, setModo] = useState('login') // 'login' | 'registro' | 'convite'
  const [loading, setLoading] = useState(false)

  // Dados do formulário
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [nome, setNome] = useState('')
  const [nomeOrg, setNomeOrg] = useState('')
  const [token, setToken] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const convite = params.get('convite')
    if (convite) {
      setToken(convite)
      setModo('convite')
    }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      if (modo === 'login') {
        await login(email, senha)
        toast.success('Bem-vindo!')
      } else if (modo === 'registro') {
        if (!nome.trim()) return toast.error('Informe seu nome')
        if (!nomeOrg.trim()) return toast.error('Informe o nome da sua pizzaria/empresa')
        await registrar(email, senha, nome.trim(), nomeOrg.trim())
        toast.success('Conta criada! Bem-vindo!')
      } else if (modo === 'convite') {
        if (!nome.trim()) return toast.error('Informe seu nome')
        await entrarPorConvite(email, senha, nome.trim(), token)
        toast.success('Você entrou na organização!')
        // limpar token da URL
        window.history.replaceState({}, '', window.location.pathname)
      }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-600 to-red-800 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-2">🍕</div>
          <h1 className="text-white text-2xl font-bold">Pier Pizza & Cantina</h1>
          <p className="text-red-200 text-sm mt-1">Controle de Estoque</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6 space-y-5">
          {modo === 'convite' && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center">
              <p className="text-green-700 font-medium text-sm">🎉 Você foi convidado!</p>
              <p className="text-green-600 text-xs mt-1">Crie sua conta ou faça login para entrar na equipe.</p>
            </div>
          )}

          {modo !== 'convite' && (
            <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
              <button
                onClick={() => setModo('login')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${modo === 'login' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
              >
                Entrar
              </button>
              <button
                onClick={() => setModo('registro')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${modo === 'registro' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
              >
                Criar Conta
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {(modo === 'registro' || modo === 'convite') && (
              <div>
                <label className="label">Seu Nome</label>
                <input
                  className="input"
                  placeholder="Ex: João Silva"
                  value={nome}
                  onChange={e => setNome(e.target.value)}
                  required
                />
              </div>
            )}

            {modo === 'registro' && (
              <div>
                <label className="label">Nome da Pizzaria / Empresa</label>
                <input
                  className="input"
                  placeholder="Ex: Pier Pizza & Cantina"
                  value={nomeOrg}
                  onChange={e => setNomeOrg(e.target.value)}
                  required
                />
              </div>
            )}

            <div>
              <label className="label">E-mail</label>
              <input
                type="email"
                className="input"
                placeholder="seu@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="label">Senha</label>
              <input
                type="password"
                className="input"
                placeholder="Mínimo 6 caracteres"
                value={senha}
                onChange={e => setSenha(e.target.value)}
                minLength={6}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full disabled:opacity-50 mt-2"
            >
              {loading ? 'Aguarde...' : modo === 'login' ? 'Entrar' : modo === 'registro' ? 'Criar Conta' : 'Entrar na Equipe'}
            </button>
          </form>

          {modo === 'convite' && (
            <button onClick={() => setModo('login')} className="text-xs text-gray-400 underline w-full text-center">
              Já tenho conta — fazer login
            </button>
          )}
        </div>

        {modo === 'registro' && (
          <p className="text-center text-red-200 text-xs mt-4">
            Ao criar conta você se torna o <strong>Dono</strong> da organização
          </p>
        )}
      </div>
    </div>
  )
}
