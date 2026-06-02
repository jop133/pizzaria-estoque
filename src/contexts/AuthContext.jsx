import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [membro, setMembro] = useState(null)
  const [organizacao, setOrganizacao] = useState(null)
  const [loading, setLoading] = useState(true)
  const bloqueandoRef = useRef(false)

  async function carregarPerfil(userId) {
    const { data } = await supabase
      .from('membros')
      .select('*, organizacoes(*)')
      .eq('user_id', userId)
      .single()

    if (data) {
      setMembro(data)
      setOrganizacao(data.organizacoes)
      session.userId = userId
      session.organizacaoId = data.organizacao_id
      session.papel = data.papel
    } else {
      setMembro(null)
      setOrganizacao(null)
      session.userId = userId
      session.organizacaoId = null
      session.papel = null
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (s?.user) {
        setUser(s.user)
        carregarPerfil(s.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      if (bloqueandoRef.current) return
      if (s?.user) {
        setUser(s.user)
        carregarPerfil(s.user.id)
      } else {
        setUser(null)
        setMembro(null)
        setOrganizacao(null)
        session.userId = null
        session.organizacaoId = null
        session.papel = null
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function login(email, senha) {
    const { error } = await supabase.auth.signInWithPassword({ email, password: senha })
    if (error) throw new Error(error.message)
  }

  // Apenas cria a conta — organização é criada separadamente
  async function registrar(email, senha, nome) {
    bloqueandoRef.current = true
    try {
      const { data, error } = await supabase.auth.signUp({ email, password: senha })
      if (error) throw new Error(error.message)
      if (!data.user?.id) throw new Error('Erro ao criar conta')

      // Faz login explícito para garantir sessão ativa
      const { error: loginErr } = await supabase.auth.signInWithPassword({ email, password: senha })
      if (loginErr) throw new Error(loginErr.message)

      setUser(data.user)
    } finally {
      bloqueandoRef.current = false
    }
  }

  // Cria organização para o usuário logado e o torna Dono (via RPC segura)
  async function criarOrganizacao(nomeOrg, nomeUsuario) {
    const { data: { session: s } } = await supabase.auth.getSession()
    const u = s?.user
    if (!u) throw new Error('Sessão não encontrada — faça login novamente')

    const { error } = await supabase.rpc('criar_organizacao', {
      nome_org: nomeOrg,
      nome_usuario: nomeUsuario || u.email,
    })
    if (error) throw new Error(error.message)

    await carregarPerfil(u.id)
  }

  async function entrarPorConvite(email, senha, nome, token) {
    bloqueandoRef.current = true
    try {
      let userId
      // Tenta login primeiro; se falhar, cria conta
      const { data: loginData, error: loginErr } = await supabase.auth.signInWithPassword({ email, password: senha })
      if (loginErr) {
        const { error: regErr } = await supabase.auth.signUp({ email, password: senha })
        if (regErr) throw new Error(regErr.message)
        // Garante sessão ativa após cadastro
        const { data: postLogin, error: postErr } = await supabase.auth.signInWithPassword({ email, password: senha })
        if (postErr) throw new Error(postErr.message)
        userId = postLogin.user?.id
        if (postLogin.user) setUser(postLogin.user)
      } else {
        userId = loginData.user?.id
        if (loginData.user) setUser(loginData.user)
      }
      if (!userId) throw new Error('Erro na autenticação')

      const { error } = await supabase.rpc('entrar_por_convite', {
        convite_token: token,
        nome_usuario: nome || email,
      })
      if (error) throw new Error(error.message)

      await carregarPerfil(userId)
    } finally {
      bloqueandoRef.current = false
    }
  }

  async function logout() {
    await supabase.auth.signOut()
  }

  async function recarregarPerfil() {
    if (user) await carregarPerfil(user.id)
  }

  const value = {
    user,
    membro,
    organizacao,
    loading,
    organizacaoId: membro?.organizacao_id ?? null,
    papel: membro?.papel ?? null,
    isDono: membro?.papel === 'dono',
    isAdmin: membro?.papel === 'admin' || membro?.papel === 'dono',
    login,
    registrar,
    criarOrganizacao,
    entrarPorConvite,
    logout,
    recarregarPerfil,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
