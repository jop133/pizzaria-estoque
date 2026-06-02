import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [membros, setMembros] = useState([]) // todas as participações do usuário
  const [orgAtualId, setOrgAtualId] = useState(() => localStorage.getItem('orgAtualId') || null)
  const [loading, setLoading] = useState(true)
  const bloqueandoRef = useRef(false)

  // Participação ativa (organização selecionada)
  const membro = membros.find(m => m.organizacao_id === orgAtualId) || membros[0] || null
  const organizacao = membro?.organizacoes || null

  // Mantém o singleton de sessão sincronizado com a org ativa
  useEffect(() => {
    session.userId = user?.id ?? null
    session.organizacaoId = membro?.organizacao_id ?? null
    session.papel = membro?.papel ?? null
  }, [user, membro])

  // Garante que orgAtualId aponte para uma org válida
  useEffect(() => {
    if (membros.length === 0) return
    if (!membros.some(m => m.organizacao_id === orgAtualId)) {
      definirOrg(membros[0].organizacao_id)
    }
  }, [membros]) // eslint-disable-line react-hooks/exhaustive-deps

  function definirOrg(orgId) {
    setOrgAtualId(orgId)
    if (orgId) localStorage.setItem('orgAtualId', orgId)
    else localStorage.removeItem('orgAtualId')
  }

  async function carregarPerfil(userId) {
    const { data: rows } = await supabase
      .from('membros')
      .select('*, organizacoes(*)')
      .eq('user_id', userId)
      .order('criado_em', { ascending: true })

    setMembros(rows || [])
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
        setMembros([])
        definirOrg(null)
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

      const { error: loginErr } = await supabase.auth.signInWithPassword({ email, password: senha })
      if (loginErr) throw new Error(loginErr.message)

      setUser(data.user)
    } finally {
      bloqueandoRef.current = false
    }
  }

  // Cria nova organização e torna o usuário logado Dono (via RPC segura)
  async function criarOrganizacao(nomeOrg, nomeUsuario) {
    const { data: { session: s } } = await supabase.auth.getSession()
    const u = s?.user
    if (!u) throw new Error('Sessão não encontrada — faça login novamente')

    const { data: novaOrgId, error } = await supabase.rpc('criar_organizacao', {
      nome_org: nomeOrg,
      nome_usuario: nomeUsuario || u.email,
    })
    if (error) throw new Error(error.message)

    if (novaOrgId) definirOrg(novaOrgId)
    await carregarPerfil(u.id)
  }

  async function entrarPorConvite(email, senha, nome, token, criarConta) {
    bloqueandoRef.current = true
    try {
      let userId
      if (criarConta) {
        const { error: regErr } = await supabase.auth.signUp({ email, password: senha })
        if (regErr) throw new Error(regErr.message)
        const { data: postLogin, error: postErr } = await supabase.auth.signInWithPassword({ email, password: senha })
        if (postErr) throw new Error(postErr.message)
        userId = postLogin.user?.id
        if (postLogin.user) setUser(postLogin.user)
      } else {
        const { data: loginData, error: loginErr } = await supabase.auth.signInWithPassword({ email, password: senha })
        if (loginErr) throw new Error('E-mail ou senha incorretos')
        userId = loginData.user?.id
        if (loginData.user) setUser(loginData.user)
      }
      if (!userId) throw new Error('Erro na autenticação')

      const { data: orgId, error } = await supabase.rpc('entrar_por_convite', {
        convite_token: token,
        nome_usuario: nome || email,
      })
      if (error) throw new Error(error.message)

      if (orgId) definirOrg(orgId)
      await carregarPerfil(userId)
    } finally {
      bloqueandoRef.current = false
    }
  }

  // Aceita convite estando já logado (usado ao abrir link com sessão ativa)
  async function aceitarConvite(token) {
    if (!user) throw new Error('Faça login para aceitar o convite')
    const { data: orgId, error } = await supabase.rpc('entrar_por_convite', {
      convite_token: token,
      nome_usuario: membro?.nome || user.email,
    })
    if (error) throw new Error(error.message)
    if (orgId) definirOrg(orgId)
    await carregarPerfil(user.id)
    return orgId
  }

  function trocarOrg(orgId) {
    definirOrg(orgId)
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
    membros,
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
    aceitarConvite,
    trocarOrg,
    logout,
    recarregarPerfil,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
