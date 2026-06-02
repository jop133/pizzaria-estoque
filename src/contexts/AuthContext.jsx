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
      const userId = data.user?.id
      if (!userId) throw new Error('Erro ao criar conta')
      setUser(data.user)
      // Não carrega perfil ainda — usuário ainda não tem organização
    } finally {
      bloqueandoRef.current = false
    }
  }

  // Cria organização para o usuário logado e o torna Dono
  async function criarOrganizacao(nomeOrg, nomeUsuario) {
    // Usa o user do estado React — mais confiável que getUser() logo após signup
    const { data: { session: s } } = await supabase.auth.getSession()
    const u = s?.user
    if (!u) throw new Error('Sessão não encontrada. Faça login novamente.')

    const { data: org, error: orgErr } = await supabase
      .from('organizacoes')
      .insert({ nome: nomeOrg, dono_id: u.id })
      .select()
      .single()
    if (orgErr) throw new Error('Erro ao criar organização: ' + orgErr.message)

    const { error: memErr } = await supabase
      .from('membros')
      .insert({ organizacao_id: org.id, user_id: u.id, papel: 'dono', nome: nomeUsuario || u.email, email: u.email })
    if (memErr) throw new Error('Erro ao criar membro: ' + memErr.message)

    await carregarPerfil(u.id)
  }

  async function entrarPorConvite(email, senha, nome, token) {
    bloqueandoRef.current = true
    try {
      const { data: convite, error: convErr } = await supabase
        .from('convites')
        .select('*')
        .eq('token', token)
        .eq('usado', false)
        .gt('expira_em', new Date().toISOString())
        .single()

      if (convErr || !convite) throw new Error('Convite inválido ou expirado')

      let userId
      // Tenta login primeiro; se falhar, cria conta
      const { data: loginData, error: loginErr } = await supabase.auth.signInWithPassword({ email, password: senha })
      if (loginErr) {
        const { data: regData, error: regErr } = await supabase.auth.signUp({ email, password: senha })
        if (regErr) throw new Error(regErr.message)
        userId = regData.user?.id
        if (regData.user) setUser(regData.user)
      } else {
        userId = loginData.user?.id
        if (loginData.user) setUser(loginData.user)
      }
      if (!userId) throw new Error('Erro na autenticação')

      await supabase.from('convites').update({ usado: true }).eq('id', convite.id)

      const { error: memErr } = await supabase
        .from('membros')
        .upsert({ organizacao_id: convite.organizacao_id, user_id: userId, papel: 'funcionario', nome, email })
      if (memErr) throw new Error(memErr.message)

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
