import { useLancamentos, useProdutos } from '../hooks/useEstoque'
import { formatBRL } from '../lib/custos'
import { exportarEstoqueCSV, exportarEstoquePDF, exportarHistoricoCSV } from '../services/importExport'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts'
import { useState } from 'react'
import { Modal } from '../components/Modal'

const CORES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899']

// Cor fixa por categoria (consistente entre sessões; paleta harmônica).
const COR_CATEGORIA = {
  'Laticínios e Frios': '#fbbf24',
  'Proteínas': '#ef4444',
  'Hortifruti': '#22c55e',
  'Mercearia': '#b45309',
  'Produções Internas': '#8b5cf6',
  'Bebidas': '#3b82f6',
  'Embalagens e Etiquetas': '#f97316',
  'Limpeza': '#06b6d4',
  'Porcionados': '#ec4899',
  'Outros': '#94a3b8',
}
const PALETA_EXTRA = ['#14b8a6', '#eab308', '#a855f7', '#f43f5e', '#0ea5e9']
const corDaCategoria = (name, i) => COR_CATEGORIA[name] || PALETA_EXTRA[i % PALETA_EXTRA.length]

// Categorias antigas → novas (evita fatias duplicadas na rosca).
const NORMALIZAR_CAT = {
  'Bebida': 'Bebidas',
  'Embalagem': 'Embalagens e Etiquetas',
  'Vegetal': 'Hortifruti',
  'Produção': 'Produções Internas',
  'Produções': 'Produções Internas',
}

export function Relatorios() {
  const lancamentos = useLancamentos()
  const produtos = useProdutos()
  const [periodo, setPeriodo] = useState('7')
  const [mostrarContagem, setMostrarContagem] = useState(false)

  const dias = parseInt(periodo)
  const filtrados = lancamentos.filter(l => {
    const diff = (new Date() - new Date(l.data)) / (1000 * 60 * 60 * 24)
    return diff <= dias
  })

  const saidas = filtrados.filter(l => l.tipo !== 'entrada')
  const entradas = filtrados.filter(l => l.tipo === 'entrada')

  // Consumo agrupado por item
  const consumoMap = {}
  saidas.forEach(l => {
    const key = l.nomeFicha || l.nomeProduto || 'Sem nome'
    consumoMap[key] = (consumoMap[key] || 0) + l.quantidade
  })
  const consumoData = Object.entries(consumoMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }))

  // Estoque por categoria (quantidade). Unifica categorias antigas nas novas
  // e agrupa fatias minúsculas (<2% do total) numa fatia "Outros".
  const catMap = {}
  produtos.forEach(p => {
    const cat = NORMALIZAR_CAT[p.categoria] || p.categoria || 'Outros'
    catMap[cat] = (catMap[cat] || 0) + (p.quantidade || 0)
  })
  const catTotal = Object.values(catMap).reduce((s, v) => s + v, 0)
  const catData = []
  let catOutros = 0
  Object.entries(catMap)
    .map(([name, value]) => ({ name, value: parseFloat(value.toFixed(2)) }))
    .filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .forEach(d => {
      if (catTotal > 0 && d.name !== 'Outros' && d.value / catTotal < 0.02) catOutros += d.value
      else catData.push(d)
    })
  if (catOutros > 0) {
    const i = catData.findIndex(d => d.name === 'Outros')
    if (i >= 0) catData[i] = { name: 'Outros', value: parseFloat((catData[i].value + catOutros).toFixed(2)) }
    else catData.push({ name: 'Outros', value: parseFloat(catOutros.toFixed(2)) })
    catData.sort((a, b) => b.value - a.value)
  }

  // --- Relatório de Contagem (ajustes de inventário num período) ---------------
  // Consolida os lançamentos tipo 'ajuste' entre data inicial e final (a contagem
  // pode atravessar dias). Δ vem da observação "Contagem: X → Y (±Δ)".
  const fmtData = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const [contIni, setContIni] = useState(() => fmtData(new Date(Date.now() - 7 * 864e5)))
  const [contFim, setContFim] = useState(() => fmtData(new Date()))
  const round3 = v => Math.round((v || 0) * 1000) / 1000
  const parseDelta = obs => {
    const m = (obs || '').match(/\(([+-]?\d+(?:[.,]\d+)?)\)/)
    return m ? parseFloat(m[1].replace(',', '.')) : 0
  }
  const prodMap = Object.fromEntries(produtos.map(p => [p.id, p]))
  const iniD = new Date(contIni + 'T00:00:00')
  const fimD = new Date(contFim + 'T23:59:59.999')
  const contMap = {}
  for (const l of lancamentos) {
    if (l.tipo !== 'ajuste' || l.produto_id == null) continue
    const d = new Date(l.data)
    if (d < iniD || d > fimD) continue
    if (!contMap[l.produto_id]) contMap[l.produto_id] = { id: l.produto_id, nome: l.nomeProduto || prodMap[l.produto_id]?.nome || 'Produto', netD: 0, depois: l.quantidade, data: l.data }
    const g = contMap[l.produto_id]
    g.netD += parseDelta(l.observacao)
    if (d >= new Date(g.data)) { g.depois = l.quantidade; g.data = l.data } // último = contagem final
  }
  const contRows = Object.values(contMap)
    .map(g => {
      const p = prodMap[g.id]
      const netD = round3(g.netD)
      const rs = netD * (p?.preco || 0)
      return { ...g, netD, antes: round3(g.depois - netD), unidade: p?.unidade || '', rs }
    })
    .filter(r => r.netD !== 0)
    .sort((a, b) => Math.abs(b.rs) - Math.abs(a.rs))
  const contFalta = contRows.filter(r => r.netD < 0).length
  const contSobra = contRows.filter(r => r.netD > 0).length
  const contValor = contRows.reduce((s, r) => s + r.rs, 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">Relatórios</h1>
        <select value={periodo} onChange={e => setPeriodo(e.target.value)} className="input w-auto">
          <option value="1">Hoje</option>
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="90">Últimos 90 dias</option>
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Saídas" value={saidas.length} color="red" />
        <Stat label="Entradas" value={entradas.length} color="green" />
        <Stat label="Itens em Estoque" value={produtos.length} color="blue" />
        <Stat label="Abaixo do Mínimo" value={produtos.filter(p => p.quantidade <= (p.estoque_minimo || 0)).length} color="orange" />
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setMostrarContagem(true)} className="btn-secondary text-sm">📋 Relatório de Contagem</button>
        <button onClick={() => exportarEstoqueCSV(produtos)} className="btn-secondary text-sm">📤 Estoque CSV</button>
        <button onClick={() => exportarEstoquePDF(produtos)} className="btn-secondary text-sm">📄 Estoque PDF</button>
        <button onClick={() => exportarHistoricoCSV(lancamentos)} className="btn-secondary text-sm">📤 Histórico CSV</button>
      </div>

      {/* Relatório de Contagem (período) — abre em tela própria */}
      {mostrarContagem && (
        <Modal title="📋 Relatório de Contagem" onClose={() => setMostrarContagem(false)}>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <input type="date" value={contIni} max={contFim} onChange={e => setContIni(e.target.value)} className="input w-auto" />
              <span className="text-gray-400">até</span>
              <input type="date" value={contFim} min={contIni} onChange={e => setContFim(e.target.value)} className="input w-auto" />
            </div>

            {contRows.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">Nenhum ajuste de contagem no período selecionado.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="font-medium text-gray-700">{contRows.length} insumo(s) ajustado(s)</span>
                  <span className="text-red-600">🔴 {contFalta} falta</span>
                  <span className="text-green-600">🟢 {contSobra} sobra</span>
                  <span className={`font-semibold ${contValor < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    Valor líquido: {formatBRL(contValor)}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                      <tr>
                        <th className="text-left px-3 py-2">Insumo</th>
                        <th className="text-right px-3 py-2 whitespace-nowrap">Antes → Depois</th>
                        <th className="text-right px-3 py-2">Δ</th>
                        <th className="text-right px-3 py-2">R$</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contRows.map(r => (
                        <tr key={r.id} className="border-t border-gray-100">
                          <td className="px-3 py-2 font-medium text-gray-800">{r.nome}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-500 text-xs whitespace-nowrap">{r.antes} → {r.depois} {r.unidade}</td>
                          <td className={`px-3 py-2 text-right font-mono font-semibold ${r.netD < 0 ? 'text-red-600' : 'text-green-600'}`}>
                            {r.netD > 0 ? '+' : ''}{r.netD} {r.unidade}
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${r.rs < 0 ? 'text-red-600' : 'text-green-600'}`}>{formatBRL(r.rs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {consumoData.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="font-semibold text-gray-700 mb-4">Top Consumo no Período</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={consumoData} margin={{ top: 0, right: 10, left: -20, bottom: 70 }}>
              <XAxis dataKey="name" angle={-40} textAnchor="end" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {consumoData.map((_, i) => <Cell key={i} fill={CORES[i % CORES.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {catData.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="font-semibold text-gray-700 mb-4">Estoque por Categoria</h2>
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <div className="relative mx-auto shrink-0" style={{ width: 220, height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={62} outerRadius={95} paddingAngle={2} stroke="none">
                    {catData.map((d, i) => <Cell key={d.name} fill={corDaCategoria(d.name, i)} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v, n]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-3xl font-bold text-gray-800">{catData.length}</span>
                <span className="text-xs text-gray-400">categorias</span>
              </div>
            </div>
            <ul className="flex-1 space-y-1.5 min-w-0">
              {catData.map((d, i) => {
                const pct = catTotal > 0 ? (d.value / catTotal) * 100 : 0
                return (
                  <li key={d.name} className="flex items-center gap-2 text-sm">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: corDaCategoria(d.name, i) }} />
                    <span className="text-gray-700 truncate flex-1">{d.name}</span>
                    <span className="font-mono text-gray-400 text-xs shrink-0">{d.value}</span>
                    <span className="font-mono text-gray-800 text-xs shrink-0 w-10 text-right">{pct.toFixed(0)}%</span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h2 className="font-semibold text-gray-700 mb-3">Estoque Atual Completo</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Produto</th>
                <th className="text-left px-3 py-2">Categoria</th>
                <th className="text-right px-3 py-2">Quantidade</th>
                <th className="text-right px-3 py-2">Mínimo</th>
                <th className="text-center px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {produtos.map(p => (
                <tr key={p.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-medium text-gray-800">{p.nome}</td>
                  <td className="px-3 py-2 text-gray-500">{p.categoria}</td>
                  <td className="px-3 py-2 text-right font-mono">{p.quantidade} {p.unidade}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-400">{p.estoque_minimo} {p.unidade}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${p.quantidade <= (p.estoque_minimo || 0) ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                      {p.quantidade <= (p.estoque_minimo || 0) ? 'BAIXO' : 'OK'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color }) {
  const c = { red: 'text-red-600 bg-red-50', green: 'text-green-600 bg-green-50', blue: 'text-blue-600 bg-blue-50', orange: 'text-orange-600 bg-orange-50' }
  return (
    <div className={`rounded-xl p-4 ${c[color]}`}>
      <p className="text-xs font-medium opacity-70">{label}</p>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  )
}
