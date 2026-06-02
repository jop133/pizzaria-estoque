import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

export function Login() {
  const { login, registrar, criarOrganizacao, entrarPorConvite, user } = useAuth()
  const [modo, setModo] = useState('login') // 'login' | 'registro' | 'criar_org' | 'convite' | 'recuperar'
  const [conviteAuth, setConviteAuth] = useState('login') // 'login' | 'registro'
  const [loading, setLoading] = useState(false)

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

  // Se o usuário está logado mas sem org, vai para tela de criar org
  useEffect(() => {
    if (user && modo !== 'criar_org' && modo !== 'convite') {
      setModo('criar_org')
    }
  }, [user])

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    try {
      await login(email, senha)
      toast.success('Bem-vindo!')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleRegistro(e) {
    e.preventDefault()
    if (!nome.trim()) return toast.error('Informe seu nome')
    setLoading(true)
    try {
      await registrar(email, senha, nome.trim())
      setModo('criar_org')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleCriarOrg(e) {
    e.preventDefault()
    if (!nomeOrg.trim()) return toast.error('Informe o nome da organização')
    setLoading(true)
    try {
      await criarOrganizacao(nomeOrg.trim(), nome.trim())
      toast.success('Organização criada! Bem-vindo!')
    } catch (err) {
      toast.error(err.message || 'Erro desconhecido ao criar organização', { duration: 6000 })
      console.error('Erro criarOrganizacao:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleConvite(e) {
    e.preventDefault()
    const criarConta = conviteAuth === 'registro'
    if (criarConta && !nome.trim()) return toast.error('Informe seu nome')
    setLoading(true)
    try {
      await entrarPorConvite(email, senha, nome.trim(), token, criarConta)
      toast.success('Você entrou na organização!')
      window.history.replaceState({}, '', window.location.pathname)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleRecuperar(e) {
    e.preventDefault()
    setLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      })
      if (error) throw new Error(error.message)
      toast.success('E-mail de recuperação enviado! Verifique sua caixa de entrada.')
      setModo('login')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function sair() {
    await supabase.auth.signOut()
    setModo('login')
  }

  return (
    <div className="min-h-screen relative flex items-center justify-center p-4">
      {/* Fundo: foto da fachada + escurecimento para contraste */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: 'url(/login-bg.webp)' }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/55 to-rose-950/85" />

      <div className="relative w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-white shadow-lg ring-4 ring-white/25 overflow-hidden">
            <img src="/logo.png" alt="Pier Pizza & Cantina" className="w-20 h-20 object-contain" />
          </div>
          <h1 className="text-white text-2xl font-bold mt-3 drop-shadow-lg">Pier Pizza &amp; Cantina</h1>
          <p className="text-rose-100 text-sm mt-1 drop-shadow">Controle de Estoque</p>
        </div>

        <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl p-6 space-y-5">

          {/* ── CRIAR ORGANIZAÇÃO ── */}
          {modo === 'criar_org' && (
            <>
              <div className="text-center space-y-1">
                <p className="text-3xl">🏢</p>
                <h2 className="font-bold text-gray-800">Criar Organização</h2>
                <p className="text-xs text-gray-500">Dê um nome para sua pizzaria ou empresa. Todos os membros convidados compartilharão o mesmo estoque.</p>
              </div>
              <form onSubmit={handleCriarOrg} className="space-y-3">
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
                <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
                  {loading ? 'Criando...' : '✅ Criar Organização'}
                </button>
              </form>
              <button onClick={sair} className="text-xs text-gray-400 underline w-full text-center">
                Voltar ao login
              </button>
            </>
          )}

          {/* ── CONVITE ── */}
          {modo === 'convite' && (
            <>
              <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center">
                <p className="text-green-700 font-medium text-sm">🎉 Você foi convidado!</p>
                <p className="text-green-600 text-xs mt-1">Já tem conta? Faça login. Senão, crie uma para entrar na equipe.</p>
              </div>

              <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
                <button
                  type="button"
                  onClick={() => setConviteAuth('login')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${conviteAuth === 'login' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
                >
                  Já tenho conta
                </button>
                <button
                  type="button"
                  onClick={() => setConviteAuth('registro')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${conviteAuth === 'registro' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
                >
                  Criar conta
                </button>
              </div>

              <form onSubmit={handleConvite} className="space-y-3">
                {conviteAuth === 'registro' && (
                  <div>
                    <label className="label">Seu Nome</label>
                    <input className="input" placeholder="Ex: João Silva" value={nome} onChange={e => setNome(e.target.value)} required />
                  </div>
                )}
                <div>
                  <label className="label">E-mail</label>
                  <input type="email" className="input" placeholder="seu@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
                </div>
                <div>
                  <label className="label">Senha</label>
                  <input type="password" className="input" placeholder={conviteAuth === 'registro' ? 'Mínimo 6 caracteres' : 'Sua senha'} value={senha} onChange={e => setSenha(e.target.value)} minLength={conviteAuth === 'registro' ? 6 : undefined} required />
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
                  {loading ? 'Aguarde...' : (conviteAuth === 'registro' ? 'Criar conta e entrar' : 'Entrar na Equipe')}
                </button>
              </form>
            </>
          )}

          {/* ── RECUPERAR SENHA ── */}
          {modo === 'recuperar' && (
            <>
              <div className="text-center">
                <p className="text-2xl mb-1">🔑</p>
                <h2 className="font-bold text-gray-800">Recuperar Senha</h2>
                <p className="text-xs text-gray-500 mt-1">Informe seu e-mail e enviaremos um link para redefinir sua senha.</p>
              </div>
              <form onSubmit={handleRecuperar} className="space-y-3">
                <div>
                  <label className="label">E-mail</label>
                  <input type="email" className="input" placeholder="seu@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
                  {loading ? 'Enviando...' : 'Enviar link de recuperação'}
                </button>
              </form>
              <button onClick={() => setModo('login')} className="text-xs text-gray-400 underline w-full text-center">
                Voltar ao login
              </button>
            </>
          )}

          {/* ── LOGIN / REGISTRO ── */}
          {(modo === 'login' || modo === 'registro') && (
            <>
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

              {modo === 'login' && (
                <form onSubmit={handleLogin} className="space-y-3">
                  <div>
                    <label className="label">E-mail</label>
                    <input type="email" className="input" placeholder="seu@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
                  </div>
                  <div>
                    <label className="label">Senha</label>
                    <input type="password" className="input" placeholder="Sua senha" value={senha} onChange={e => setSenha(e.target.value)} required />
                  </div>
                  <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
                    {loading ? 'Aguarde...' : 'Entrar'}
                  </button>
                  <button type="button" onClick={() => setModo('recuperar')} className="text-xs text-gray-400 underline w-full text-center">
                    Esqueci minha senha
                  </button>
                </form>
              )}

              {modo === 'registro' && (
                <form onSubmit={handleRegistro} className="space-y-3">
                  <div>
                    <label className="label">Seu Nome</label>
                    <input className="input" placeholder="Ex: João Silva" value={nome} onChange={e => setNome(e.target.value)} required />
                  </div>
                  <div>
                    <label className="label">E-mail</label>
                    <input type="email" className="input" placeholder="seu@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
                  </div>
                  <div>
                    <label className="label">Senha</label>
                    <input type="password" className="input" placeholder="Mínimo 6 caracteres" value={senha} onChange={e => setSenha(e.target.value)} minLength={6} required />
                  </div>
                  <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
                    {loading ? 'Aguarde...' : 'Criar Conta'}
                  </button>
                </form>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  )
}
