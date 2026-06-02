import { useProdutos, useLancamentos, useProdutosAbaixoMinimo } from '../hooks/useEstoque'
import { supabase } from '../lib/supabase'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts'

export function Dashboard() {
  const produtos = useProdutos()
  const lancamentos = useLancamentos()
  const abaixoMinimo = useProdutosAbaixoMinimo()

  const totalProdutos = produtos.length
  const totalItens = produtos.reduce((s, p) => s + (p.quantidade || 0), 0)

  const ultimos7dias = lancamentos.filter(l => {
    const d = new Date(l.data)
    const agora = new Date()
    return (agora - d) / (1000 * 60 * 60 * 24) <= 7
  })

  const consumoPorProduto = {}
  ultimos7dias
    .filter(l => l.tipo !== 'entrada')
    .forEach(l => {
      const key = l.nomeProduto || l.nomeFicha || 'Sem nome'
      consumoPorProduto[key] = (consumoPorProduto[key] || 0) + l.quantidade
    })
  const chartData = Object.entries(consumoPorProduto)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, value]) => ({ name, value }))

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Produtos Cadastrados" value={totalProdutos} color="blue" />
        <Card label="Total em Estoque" value={totalItens.toFixed(1)} color="green" />
        <Card label="Abaixo do Mínimo" value={abaixoMinimo.length} color={abaixoMinimo.length > 0 ? 'red' : 'green'} />
        <Card label="Lançamentos (7d)" value={ultimos7dias.length} color="orange" />
      </div>

      {abaixoMinimo.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
          <h2 className="text-rose-700 font-semibold mb-3 flex items-center gap-2">
            <span>⚠️</span> Estoque Baixo — Atenção
          </h2>
          <div className="flex flex-wrap gap-2">
            {abaixoMinimo.map(p => (
              <div key={p.id} className="bg-white border border-rose-200 rounded-lg px-3 py-2">
                <p className="font-medium text-gray-800 text-sm">{p.nome}</p>
                <p className="text-xs text-rose-600">
                  {p.quantidade} {p.unidade} / mín. {p.estoque_minimo} {p.unidade}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {chartData.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="font-semibold text-gray-700 mb-4">Top Consumo (últimos 7 dias)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ top: 0, right: 10, left: -20, bottom: 60 }}>
              <XAxis dataKey="name" angle={-35} textAnchor="end" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {chartData.map((_, i) => (
                  <Cell key={i} fill={`hsl(${200 + i * 20}, 70%, 50%)`} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h2 className="font-semibold text-gray-700 mb-3">Últimos Lançamentos</h2>
        {lancamentos.length === 0 ? (
          <p className="text-gray-400 text-sm">Nenhum lançamento ainda.</p>
        ) : (
          <div className="space-y-2">
            {lancamentos.slice(0, 10).map(l => (
              <div key={l.id} className="flex items-center justify-between text-sm py-1 border-b border-gray-100 last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge color={l.tipo === 'entrada' ? 'green' : 'red'}>
                    {l.tipo === 'entrada' ? '+ Entrada' : l.tipo === 'saida_ficha' ? '- Ficha' : '- Manual'}
                  </Badge>
                  <span className="text-gray-700 truncate">{l.nomeFicha || l.nomeProduto}</span>
                </div>
                <div className="flex items-center gap-2 text-gray-500 shrink-0">
                  <span>{l.quantidade}</span>
                  <span className="text-xs">{new Date(l.data).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <button
                    onClick={async () => { await supabase.from('lancamentos').delete().eq('id', l.id); toast.success('Lançamento removido') }}
                    className="text-gray-300 hover:text-rose-500 transition-colors ml-1"
                    title="Excluir lançamento"
                  >✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Card({ label, value, color }) {
  const colors = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    red: 'bg-rose-50 border-rose-200 text-rose-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
  }
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className="text-xs font-medium opacity-70">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  )
}
