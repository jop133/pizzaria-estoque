import { useState } from 'react'
import { useLancamentos } from '../hooks/useEstoque'
import { exportarHistoricoCSV } from '../services/importExport'
import { db } from '../db'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

export function Historico() {
  const lancamentos = useLancamentos()
  const [filtroTipo, setFiltroTipo] = useState('')
  const [busca, setBusca] = useState('')
  const [periodo, setPeriodo] = useState('todos')

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

  const tipoBadge = { entrada: 'green', saida_ficha: 'orange', saida_manual: 'red' }
  const tipoLabel = { entrada: '+ Entrada', saida_ficha: '- Ficha', saida_manual: '- Manual' }

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
        </select>
        <select value={periodo} onChange={e => setPeriodo(e.target.value)} className="input w-auto">
          <option value="todos">Todo período</option>
          <option value="1">Hoje</option>
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtrados.length === 0 ? (
          <p className="text-gray-400 text-sm p-6 text-center">Nenhum lançamento encontrado.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
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
                <tr key={l.id} className="border-t border-gray-100 hover:bg-gray-50">
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
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{l.quantidade}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs hidden md:table-cell">{l.observacao || '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={async () => { await db.lancamentos.delete(l.id); toast.success('Removido') }}
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
