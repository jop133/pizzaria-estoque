import { useState, useEffect } from 'react'
import { useLancamentos } from '../hooks/useEstoque'
import { useAuth } from '../contexts/AuthContext'
import { exportarHistoricoCSV } from '../services/importExport'
import { excluirLancamento } from '../services/estoque'
import { TIPO_LABEL, TIPO_COR, TIPOS_MOVIMENTACAO, TIPOS_CADASTRO, ehCadastro } from '../lib/lancamentos'
import { supabase } from '../lib/supabase'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import toast from 'react-hot-toast'

export function Historico() {
  const lancamentos = useLancamentos()
  const { organizacaoId } = useAuth()
  const [filtroTipo, setFiltroTipo] = useState('')
  const [busca, setBusca] = useState('')
  const [periodo, setPeriodo] = useState('todos')
  const [selecionados, setSelecionados] = useState(new Set())
  const [membrosMap, setMembrosMap] = useState({})
  const [confirmacao, setConfirmacao] = useState(null) // { modo: 'um'|'massa', lancamento? }

  // Mapa user_id -> nome (para mostrar quem fez cada ação)
  useEffect(() => {
    if (!organizacaoId) return
    supabase
      .from('membros')
      .select('user_id, nome, email')
      .eq('organizacao_id', organizacaoId)
      .then(({ data }) => {
        const m = {}
        for (const x of data || []) m[x.user_id] = x.nome || x.email || '—'
        setMembrosMap(m)
      })
  }, [organizacaoId])

  const filtrados = lancamentos.filter(l => {
    const okTipo = !filtroTipo
      || (filtroTipo === 'g_mov' ? TIPOS_MOVIMENTACAO.includes(l.tipo)
        : filtroTipo === 'g_cad' ? TIPOS_CADASTRO.includes(l.tipo)
          : l.tipo === filtroTipo)
    const nome = (l.nomeFicha || l.nomeProduto || '').toLowerCase()
    const okBusca = !busca || nome.includes(busca.toLowerCase())
    let okPeriodo = true
    if (periodo !== 'todos') {
      const dias = parseInt(periodo)
      const diff = (new Date() - new Date(l.data)) / (1000 * 60 * 60 * 24)
      okPeriodo = diff <= dias
    }
    return okTipo && okBusca && okPeriodo
  })

  const todosSelecionados = filtrados.length > 0 && filtrados.every(l => selecionados.has(l.id))

  function toggleSelecionado(id) {
    setSelecionados(prev => {
      const novo = new Set(prev)
      novo.has(id) ? novo.delete(id) : novo.add(id)
      return novo
    })
  }

  function toggleTodos() {
    if (todosSelecionados) {
      setSelecionados(new Set())
    } else {
      setSelecionados(new Set(filtrados.map(l => l.id)))
    }
  }

  // Abrem a caixa de confirmação (a exclusão de fato roda no "Prosseguir")
  function excluirUm(l) { setConfirmacao({ modo: 'um', lancamento: l }) }
  function excluirSelecionados() {
    if (selecionados.size === 0) return
    setConfirmacao({ modo: 'massa' })
  }

  async function confirmarExclusao() {
    const c = confirmacao
    setConfirmacao(null)
    if (!c) return
    try {
      if (c.modo === 'um') {
        const l = c.lancamento
        await excluirLancamento(l.id)
        toast.success(ehCadastro(l.tipo) ? 'Registro removido do histórico' : 'Lançamento excluído e revertido')
      } else {
        const alvos = lancamentos.filter(l => selecionados.has(l.id))
        for (const l of alvos) await excluirLancamento(l.id)
        setSelecionados(new Set())
        toast.success(`${alvos.length} lançamento(s) excluído(s)!`)
      }
    } catch (e) {
      toast.error(e.message || 'Erro ao excluir')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">Histórico</h1>
        <button onClick={() => exportarHistoricoCSV(filtrados)} className="btn-secondary text-sm">📤 Exportar CSV</button>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          placeholder="Buscar item..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          className="input flex-1 min-w-32"
        />
        <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)} className="input w-auto">
          <option value="">Todos os tipos</option>
          <optgroup label="Grupos">
            <option value="g_mov">Só movimentações</option>
            <option value="g_cad">Só cadastros/edições</option>
          </optgroup>
          <optgroup label="Movimentações">
            <option value="entrada">Entradas</option>
            <option value="saida_ficha">Saída por Ficha</option>
            <option value="saida_manual">Saída Manual</option>
            <option value="ajuste">Ajustes</option>
            <option value="producao">Produção</option>
          </optgroup>
          <optgroup label="Cadastros e edições">
            <option value="produto_novo">Produto criado</option>
            <option value="produto_editado">Produto editado</option>
            <option value="produto_excluido">Produto excluído</option>
            <option value="ficha_nova">Ficha criada</option>
            <option value="ficha_editada">Ficha editada</option>
            <option value="ficha_excluida">Ficha excluída</option>
          </optgroup>
        </select>
        <select value={periodo} onChange={e => setPeriodo(e.target.value)} className="input w-auto">
          <option value="todos">Todo período</option>
          <option value="1">Hoje</option>
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
        </select>
      </div>

      {selecionados.size > 0 && (
        <div className="flex items-center justify-between bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <p className="text-sm font-medium text-red-700">{selecionados.size} lançamento(s) selecionado(s)</p>
          <div className="flex gap-2">
            <button onClick={() => setSelecionados(new Set())} className="text-xs text-gray-500 underline">Limpar</button>
            <button onClick={excluirSelecionados} className="btn-danger text-sm py-1">🗑 Excluir selecionados</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtrados.length === 0 ? (
          <p className="text-gray-400 text-sm p-6 text-center">Nenhum lançamento encontrado.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" checked={todosSelecionados} onChange={toggleTodos} className="w-4 h-4 accent-red-600" />
                </th>
                <th className="text-left px-4 py-3">Data</th>
                <th className="text-left px-4 py-3">Tipo</th>
                <th className="text-left px-4 py-3">Item</th>
                <th className="text-right px-4 py-3">Qtd</th>
                <th className="text-left px-4 py-3 hidden sm:table-cell">Por</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Obs.</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map(l => (
                <tr key={l.id} className={`border-t border-gray-100 hover:bg-gray-50 ${selecionados.has(l.id) ? 'bg-red-50' : ''}`}>
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selecionados.has(l.id)} onChange={() => toggleSelecionado(l.id)} className="w-4 h-4 accent-red-600" />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                    {new Date(l.data).toLocaleString('pt-BR', {
                      day: '2-digit', month: '2-digit', year: '2-digit',
                      hour: '2-digit', minute: '2-digit'
                    })}
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={TIPO_COR[l.tipo] || 'gray'}>{TIPO_LABEL[l.tipo] || l.tipo}</Badge>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {ehCadastro(l.tipo)
                      ? (l.nomeProduto || l.nomeFicha || l.observacao || '—')
                      : (l.nomeFicha || l.nomeProduto || '—')}
                    {l.marca && <span className="ml-1 text-xs text-gray-400 font-normal">· {l.marca}</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{ehCadastro(l.tipo) ? '—' : l.quantidade}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell">{membrosMap[l.user_id] || '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs hidden md:table-cell">{ehCadastro(l.tipo) ? '—' : (l.observacao || '—')}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => excluirUm(l)}
                      className="text-gray-300 hover:text-red-500 transition-colors"
                      title="Excluir"
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-400 text-right">{filtrados.length} registros</p>

      {confirmacao && (() => {
        const alvos = confirmacao.modo === 'um'
          ? [confirmacao.lancamento]
          : lancamentos.filter(l => selecionados.has(l.id))
        const revertiveis = alvos.filter(l => !ehCadastro(l.tipo)).length
        const naoRev = alvos.filter(l => ehCadastro(l.tipo)).length
        const nomeUm = confirmacao.modo === 'um'
          ? (confirmacao.lancamento.nomeFicha || confirmacao.lancamento.nomeProduto || confirmacao.lancamento.observacao || 'este lançamento')
          : ''
        return (
          <Modal title="Confirmar exclusão" onClose={() => setConfirmacao(null)}>
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                {confirmacao.modo === 'um'
                  ? <>Você vai excluir <strong>{nomeUm}</strong>.</>
                  : <>Você vai excluir <strong>{revertiveis + naoRev} lançamento(s)</strong>.</>}
              </p>

              {revertiveis > 0 && (
                <div className="flex gap-2 bg-green-50 border border-green-200 rounded-lg p-3">
                  <span className="text-green-600">✅</span>
                  <p className="text-sm text-green-800">
                    {confirmacao.modo === 'um'
                      ? 'Esta ação será REVERTIDA no estoque (o efeito será desfeito).'
                      : `${revertiveis} movimentação(ões) será(ão) REVERTIDA(S) no estoque.`}
                  </p>
                </div>
              )}

              {naoRev > 0 && (
                <div className="flex gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <span className="text-yellow-600">⚠️</span>
                  <p className="text-sm text-yellow-800">
                    {confirmacao.modo === 'um'
                      ? 'Este é um registro de cadastro: NÃO será desfeito — apenas sai do histórico (o produto/ficha não muda).'
                      : `${naoRev} registro(s) de cadastro NÃO será(ão) desfeito(s) — apenas saem do histórico.`}
                  </p>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button onClick={() => setConfirmacao(null)} className="btn-secondary flex-1">Voltar</button>
                <button onClick={confirmarExclusao} className="btn-danger flex-1">Prosseguir</button>
              </div>
            </div>
          </Modal>
        )
      })()}
    </div>
  )
}
