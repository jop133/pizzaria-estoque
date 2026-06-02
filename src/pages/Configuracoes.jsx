import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

const PAPEL_COR = { dono: 'red', admin: 'orange', funcionario: 'gray' }
const PAPEL_LABEL = { dono: '👑 Dono', admin: '⭐ Admin', funcionario: '👤 Funcionário' }

export function Configuracoes() {
  const { user, membro, membros: minhasOrgs, organizacao, papel, isDono, trocarOrg, criarOrganizacao, logout, recarregarPerfil } = useAuth()
  const [membros, setMembros] = useState([])
  const [linkConvite, setLinkConvite] = useState('')
  const [gerandoLink, setGerandoLink] = useState(false)
  const [loading, setLoading] = useState(true)
  const [novaOrg, setNovaOrg] = useState('')
  const [criandoOrg, setCriandoOrg] = useState(false)

  useEffect(() => {
    carregarMembros()
  }, [organizacao?.id])

  async function carregarMembros() {
    if (!organizacao?.id) return
    setLoading(true)
    const { data } = await supabase
      .from('membros')
      .select('*')
      .eq('organizacao_id', organizacao.id)
      .order('criado_em')
    setMembros(data || [])
    setLoading(false)
  }

  async function gerarConvite() {
    if (!isDono) return toast.error('Apenas o Dono pode gerar convites')
    setGerandoLink(true)
    try {
      const token = crypto.randomUUID().replace(/-/g, '') + Date.now().toString(36)
      const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min

      const { error } = await supabase.from('convites').insert({
        organizacao_id: organizacao.id,
        token,
        criado_por: user.id,
        expira_em: expira,
      })
      if (error) throw new Error(error.message)

      const url = `${window.location.origin}?convite=${token}`
      setLinkConvite(url)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setGerandoLink(false)
    }
  }

  async function handleCriarOrg() {
    if (!novaOrg.trim()) return toast.error('Informe o nome da organização')
    setCriandoOrg(true)
    try {
      await criarOrganizacao(novaOrg.trim(), membro?.nome || user?.email)
      toast.success('Organização criada!')
      setNovaOrg('')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setCriandoOrg(false)
    }
  }

  function copiarLink() {
    navigator.clipboard.writeText(linkConvite)
    toast.success('Link copiado!')
  }

  async function alterarPapel(membroId, novoPapel) {
    const alvo = membros.find(m => m.id === membroId)
    if (alvo?.papel === 'dono') return toast.error('O Dono não pode ser rebaixado')
    if (alvo?.user_id === user.id) return toast.error('Você não pode alterar seu próprio papel')

    const { error } = await supabase
      .from('membros')
      .update({ papel: novoPapel })
      .eq('id', membroId)
    if (error) return toast.error(error.message)

    toast.success('Papel atualizado!')
    await carregarMembros()
    await recarregarPerfil()
  }

  async function removerMembro(membroId) {
    const alvo = membros.find(m => m.id === membroId)
    if (alvo?.papel === 'dono') return toast.error('O Dono não pode ser removido')
    if (alvo?.user_id === user.id) return toast.error('Você não pode se remover')
    if (!confirm(`Remover ${alvo?.nome || alvo?.email} da organização?`)) return

    const { error } = await supabase.from('membros').delete().eq('id', membroId)
    if (error) return toast.error(error.message)

    toast.success('Membro removido')
    await carregarMembros()
  }

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-800">Configurações</h1>

      {/* Perfil */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="font-semibold text-gray-700">Minha Conta</h2>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center text-red-600 font-bold">
            {(membro?.nome || user?.email || '?')[0].toUpperCase()}
          </div>
          <div>
            <p className="font-medium text-gray-800">{membro?.nome || 'Sem nome'}</p>
            <p className="text-xs text-gray-500">{user?.email}</p>
          </div>
          <div className="ml-auto">
            <Badge color={PAPEL_COR[papel]}>{PAPEL_LABEL[papel]}</Badge>
          </div>
        </div>
        {organizacao && (
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            🏢 Organização: <strong>{organizacao.nome}</strong>
          </p>
        )}
        <button onClick={logout} className="w-full text-sm text-red-600 border border-red-200 hover:bg-red-50 rounded-xl py-2 transition-colors font-medium">
          Sair da conta
        </button>
      </div>

      {/* Minhas Organizações */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="font-semibold text-gray-700">Minhas Organizações</h2>
        <div className="space-y-2">
          {minhasOrgs.map(m => {
            const ativa = m.organizacao_id === membro?.organizacao_id
            return (
              <div key={m.organizacao_id} className="flex items-center gap-2 py-1.5 border-b border-gray-100 last:border-0">
                <span className="text-lg">🏢</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{m.organizacoes?.nome || 'Organização'}</p>
                  <p className="text-xs text-gray-400">{PAPEL_LABEL[m.papel]}</p>
                </div>
                {ativa ? (
                  <span className="text-xs text-green-600 font-medium shrink-0">● Ativa</span>
                ) : (
                  <button
                    onClick={() => trocarOrg(m.organizacao_id)}
                    className="text-xs text-red-600 border border-red-200 hover:bg-red-50 rounded-lg px-3 py-1 shrink-0"
                  >
                    Acessar
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <div className="pt-2 border-t border-gray-100 space-y-2">
          <p className="text-xs text-gray-500">Criar uma nova organização (você será o Dono):</p>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Nome da nova organização"
              value={novaOrg}
              onChange={e => setNovaOrg(e.target.value)}
            />
            <button onClick={handleCriarOrg} disabled={criandoOrg} className="btn-primary shrink-0 disabled:opacity-50">
              {criandoOrg ? '...' : 'Criar'}
            </button>
          </div>
        </div>
      </div>

      {/* Convite — só Dono */}
      {isDono && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <h2 className="font-semibold text-gray-700">Convidar Membro</h2>
          <p className="text-xs text-gray-500">Gere um link de convite único. Expira em 30 minutos ou no primeiro uso.</p>
          <button
            onClick={gerarConvite}
            disabled={gerandoLink}
            className="btn-primary w-full disabled:opacity-50"
          >
            {gerandoLink ? 'Gerando...' : '🔗 Gerar Link de Convite'}
          </button>

          {linkConvite && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-2">
              <p className="text-xs font-medium text-green-700">✅ Link gerado (válido por 30 min ou 1 uso):</p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={linkConvite}
                  className="input text-xs flex-1 bg-white"
                />
                <button onClick={copiarLink} className="btn-secondary text-sm shrink-0">Copiar</button>
              </div>
              <p className="text-xs text-yellow-600">⚠️ Compartilhe apenas com quem deve ter acesso.</p>
            </div>
          )}
        </div>
      )}

      {/* Lista de membros */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-700">Membros da Equipe</h2>
          <button onClick={carregarMembros} className="text-xs text-gray-400 hover:text-gray-600">↺ Atualizar</button>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm text-center py-4">Carregando...</p>
        ) : (
          <div className="space-y-2">
            {membros.map(m => (
              <div key={m.id} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-600 font-bold text-sm shrink-0">
                  {(m.nome || m.email || '?')[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{m.nome || 'Sem nome'}</p>
                  <p className="text-xs text-gray-400 truncate">{m.email}</p>
                </div>

                {isDono && m.papel !== 'dono' ? (
                  <div className="flex items-center gap-1">
                    <select
                      value={m.papel}
                      onChange={e => alterarPapel(m.id, e.target.value)}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white"
                    >
                      <option value="admin">⭐ Admin</option>
                      <option value="funcionario">👤 Funcionário</option>
                    </select>
                    <button
                      onClick={() => removerMembro(m.id)}
                      className="text-gray-300 hover:text-red-500 text-lg ml-1"
                      title="Remover membro"
                    >✕</button>
                  </div>
                ) : (
                  <Badge color={PAPEL_COR[m.papel]}>{PAPEL_LABEL[m.papel]}</Badge>
                )}
              </div>
            ))}
            {membros.length === 0 && (
              <p className="text-gray-400 text-sm text-center py-4">Nenhum membro encontrado</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
