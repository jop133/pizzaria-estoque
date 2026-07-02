import { useProdutos, useLancamentos, useProdutosAbaixoMinimo, useFichas, useTodosIngredientes } from '../hooks/useEstoque'
import { criarCalculadoraDeCusto, formatBRL } from '../lib/custos'
import { useState } from 'react'
import { Search } from 'lucide-react'

export function Dashboard() {
  const produtos = useProdutos()
  const lancamentos = useLancamentos()
  const abaixoMinimo = useProdutosAbaixoMinimo()
  const fichas = useFichas()
  const ingredientes = useTodosIngredientes()
  const [buscaValor, setBuscaValor] = useState('')

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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Produtos Cadastrados" value={totalProdutos} color="blue" />
        <Card label="Total em Estoque" value={totalItens.toFixed(1)} color="green" />
        <Card label="Abaixo do Mínimo" value={abaixoMinimo.length} color={abaixoMinimo.length > 0 ? 'red' : 'green'} />
        <Card label="Lançamentos (7d)" value={ultimos7dias.length} color="orange" />
      </div>

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
            <div className="relative mb-2">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                placeholder="Buscar produto..."
                value={buscaValor}
                onChange={e => setBuscaValor(e.target.value)}
                className="input pl-9"
              />
            </div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {(() => {
                const lista = valorProdutos.filter(x => x.nome.toLowerCase().includes(buscaValor.toLowerCase()))
                if (lista.length === 0) {
                  return <p className="text-sm text-gray-400 py-4 text-center">Nenhum produto encontrado.</p>
                }
                return lista.map(x => (
                  <div key={x.id} className="flex items-center justify-between text-sm border-b border-gray-100 py-1.5 last:border-0">
                    <span className="text-gray-600 truncate pr-2">{x.nome}</span>
                    <span className="font-mono text-gray-800 shrink-0">{formatBRL(x.valor)}</span>
                  </div>
                ))
              })()}
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
