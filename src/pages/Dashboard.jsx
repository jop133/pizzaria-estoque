import { useProdutos, useLancamentos, useProdutosAbaixoMinimo, useFichas, useTodosIngredientes } from '../hooks/useEstoque'
import { TIPOS_MOVIMENTACAO } from '../lib/lancamentos'
import { criarCalculadoraDeCusto, formatBRL } from '../lib/custos'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts'

export function Dashboard() {
  const produtos = useProdutos()
  const lancamentos = useLancamentos()
  const abaixoMinimo = useProdutosAbaixoMinimo()
  const fichas = useFichas()
  const ingredientes = useTodosIngredientes()

  const totalProdutos = produtos.length
  const totalItens = produtos.reduce((s, p) => s + (p.quantidade || 0), 0)

  // Valor parado no estoque: soma de (quantidade × custo) por produto.
  const custoUnit = criarCalculadoraDeCusto(produtos, fichas, ingredientes)
  const valorPorCategoria = {}
  let valorTotal = 0
  const valorProdutos = []
  for (const p of produtos) {
    const v = (p.quantidade || 0) * custoUnit(p.id)
    if (v > 0) {
      valorTotal += v
      const cat = p.categoria || 'Outros'
      valorPorCategoria[cat] = (valorPorCategoria[cat] || 0) + v
      valorProdutos.push({ id: p.id, nome: p.nome, valor: v })
    }
  }
  const valorCategorias = Object.entries(valorPorCategoria).sort((a, b) => b[1] - a[1])
  valorProdutos.sort((a, b) => b.valor - a.valor)

  const ultimos7dias = lancamentos.filter(l => {
    const d = new Date(l.data)
    const agora = new Date()
    return (agora - d) / (1000 * 60 * 60 * 24) <= 7
  })

  const consumoPorProduto = {}
  ultimos7dias
    .filter(l => TIPOS_MOVIMENTACAO.includes(l.tipo) && l.tipo !== 'entrada')
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
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <h2 className="text-red-700 font-semibold mb-3 flex items-center gap-2">
            <span>⚠️</span> Estoque Baixo — Atenção
          </h2>
          <div className="flex flex-wrap gap-2">
            {abaixoMinimo.map(p => (
              <div key={p.id} className="bg-white border border-red-200 rounded-lg px-3 py-2">
                <p className="font-medium text-gray-800 text-sm">{p.nome}</p>
                <p className="text-xs text-red-600">
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
        <h2 className="font-semibold text-gray-700 mb-1">💰 Valor em estoque</h2>
        <p className="text-3xl font-bold text-green-700">{formatBRL(valorTotal)}</p>
        <p className="text-xs text-gray-400 mb-3">Dinheiro parado: soma de (quantidade × custo) de cada produto.</p>
        {valorCategorias.length === 0 ? (
          <p className="text-gray-400 text-sm">Cadastre o preço de custo dos produtos para ver o valor.</p>
        ) : (
          <>
            <p className="text-xs font-medium text-gray-500 uppercase mb-1">Por categoria</p>
            <div className="space-y-1 mb-4">
              {valorCategorias.map(([cat, v]) => (
                <div key={cat} className="flex items-center justify-between text-sm border-b border-gray-100 py-1.5 last:border-0">
                  <span className="text-gray-600">{cat}</span>
                  <span className="font-mono text-gray-800">{formatBRL(v)}</span>
                </div>
              ))}
            </div>

            <p className="text-xs font-medium text-gray-500 uppercase mb-1">Por produto</p>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {valorProdutos.map(x => (
                <div key={x.id} className="flex items-center justify-between text-sm border-b border-gray-100 py-1.5 last:border-0">
                  <span className="text-gray-600 truncate pr-2">{x.nome}</span>
                  <span className="font-mono text-gray-800 shrink-0">{formatBRL(x.valor)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Card({ label, value, color }) {
  const colors = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
  }
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className="text-xs font-medium opacity-70">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  )
}
