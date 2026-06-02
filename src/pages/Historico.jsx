import { useState } from 'react'
import { useLancamentos } from '../hooks/useEstoque'
import { exportarHistoricoCSV } from '../services/importExport'
import { supabase } from '../lib/supabase'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

export function Historico() {
  const lancamentos = useLancamentos()
  const [filtroTipo, setFiltroTipo] = useState('')
  const [busca, setBusca] = useState('')
  const [periodo, setPeriodo] = useState('todos')
  const [selecionados, setSelecionados] = useState(new Set())

  const filtrados = lancamentos.filter(l => {
    const okTipo = !filtroTipo || l.tipo === filtroTipo
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

  async function excluirSelecionados() {
    if (selecionados.size === 0) return
    if (!confirm(`Excluir ${selecionados.size} lançamento(s) selecionado(s)? O estoque não será revertido.`)) return
    const { error } = await supabase.from('lancamentos').delete().in('id', [...selecionados])
    if (error) return toast.error('Erro ao excluir')
    setSelecionados(new Set())
    toast.success(`${selecionados.size} lançamento(s) excluído(s)!`)
  }

  const tipoBadge = { entrada: 'green', saida_ficha: 'orange', saida_manual: 'red', ajuste: 'blue' }
  const tipoLabel = { entrada: '+ Entrada', saida_ficha: '- Ficha', saida_manual: '- Manual', ajuste: '± Ajuste' }

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
          <option value="entrada">Entradas</option>
          <option value="saida_ficha">Saída por Ficha</option>
          <option value="saida_manual">Saída Manual</option>
          <option value="ajuste">Ajustes</option>
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
                    <Badge color={tipoBadge[l.tipo]}>{tipoLabel[l.tipo]}</Badge>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {l.nomeFicha || l.nomeProduto || '—'}
                    {l.marca && <span className="ml-1 text-xs text-gray-400 font-normal">· {l.marca}</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{l.quantidade}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs hidden md:table-cell">{l.observacao || '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={async () => { await supabase.from('lancamentos').delete().eq('id', l.id); toast.success('Removido') }}
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
    </div>
  )
}
