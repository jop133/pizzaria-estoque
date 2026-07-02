import { useLancamentos, useProdutos, useFichas, useTodosIngredientes } from '../hooks/useEstoque'
import { criarCalculadoraDeCusto, formatBRL } from '../lib/custos'
import { exportarEstoqueCSV, exportarEstoquePDF, exportarHistoricoCSV } from '../services/importExport'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LabelList
} from 'recharts'
import { useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from '../components/Modal'

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
  const fichas = useFichas()
  const ingredientes = useTodosIngredientes()
  const [periodo, setPeriodo] = useState('7')
  const [mostrarContagem, setMostrarContagem] = useState(false)
  const [periodoConsumo, setPeriodoConsumo] = useState('7')
  const [metricaConsumo, setMetricaConsumo] = useState('qtd')

  const dias = parseInt(periodo)
  const filtrados = lancamentos.filter(l => {
    const diff = (new Date() - new Date(l.data)) / (1000 * 60 * 60 * 24)
    return diff <= dias
  })

  const saidas = filtrados.filter(l => l.tipo !== 'entrada')
  const entradas = filtrados.filter(l => l.tipo === 'entrada')

  // Top Consumo: só saídas reais (venda por ficha + saída manual), no período
  // próprio do gráfico. Ignora ajuste/produção/cadastro. Métrica = quantidade
  // OU valor em R$ (custo consumido: produto = custo unitário; prato = Σ insumos).
  const custoUnit = criarCalculadoraDeCusto(produtos, fichas, ingredientes)
  const ingsPorFicha = {}
  for (const ing of ingredientes) (ingsPorFicha[ing.ficha_id] || (ingsPorFicha[ing.ficha_id] = [])).push(ing)
  const custoDaFicha = fichaId => (ingsPorFicha[fichaId] || []).reduce((s, ing) => s + (ing.quantidade || 0) * custoUnit(ing.produto_id), 0)
  const diasConsumo = parseInt(periodoConsumo)
  const consumoMap = {}
  for (const l of lancamentos) {
    if (l.tipo !== 'saida_ficha' && l.tipo !== 'saida_manual') continue
    if ((new Date() - new Date(l.data)) / 864e5 > diasConsumo) continue
    const ehVenda = l.tipo === 'saida_ficha'
    const nome = (ehVenda ? l.nomeFicha : l.nomeProduto) || 'Sem nome'
    const key = (ehVenda ? 'f:' : 'p:') + nome
    const qtd = l.quantidade || 0
    const valor = ehVenda ? qtd * custoDaFicha(l.ficha_id) : qtd * custoUnit(l.produto_id)
    if (!consumoMap[key]) consumoMap[key] = { nome, rotulo: (ehVenda ? '🍕 ' : '📦 ') + nome, qtd: 0, valor: 0 }
    consumoMap[key].qtd += qtd
    consumoMap[key].valor += valor
  }
  const consumoData = Object.values(consumoMap)
    .map(c => ({ ...c, value: metricaConsumo === 'valor' ? Math.round(c.valor * 100) / 100 : Math.round(c.qtd * 1000) / 1000 }))
    .filter(c => c.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)

  // Estoque por categoria (quantidade). Unifica categorias antigas nas novas
  // e agrupa fatias minúsculas (<1% do total) numa fatia "Outros".
  // Exatamente 1% (ou mais) mantém o nome; abaixo de 1% vai pra "Outros".
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
      if (catTotal > 0 && d.name !== 'Outros' && d.value / catTotal < 0.01) catOutros += d.value
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

  // Filtro da lista (Tudo / Só faltas / Só sobras), busca por nome e atalhos de período.
  const [filtroCont, setFiltroCont] = useState('todos')
  const [buscaCont, setBuscaCont] = useState('')
  const contRowsFiltrados = contRows.filter(r =>
    (filtroCont === 'todos' || (filtroCont === 'falta' ? r.netD < 0 : r.netD > 0)) &&
    (!buscaCont || r.nome.toLowerCase().includes(buscaCont.toLowerCase()))
  )
  const presetDias = dias => {
    setContIni(fmtData(new Date(Date.now() - dias * 864e5)))
    setContFim(fmtData(new Date()))
  }
  const presetMesAtual = () => {
    const h = new Date()
    setContIni(fmtData(new Date(h.getFullYear(), h.getMonth(), 1)))
    setContFim(fmtData(h))
  }

  // --- Relatório de Vendas (itens vendidos num período) ------------------------
  // Venda = saída por ficha (pratos) + saída manual (inclui bebidas). Consolida
  // por item; mostra quantidade e o custo dos insumos (não há preço de venda).
  const [mostrarVendas, setMostrarVendas] = useState(false)
  const [vendaIni, setVendaIni] = useState(() => fmtData(new Date(Date.now() - 7 * 864e5)))
  const [vendaFim, setVendaFim] = useState(() => fmtData(new Date()))
  const [buscaVenda, setBuscaVenda] = useState('')
  const [metricaVenda, setMetricaVenda] = useState('qtd') // qtd | valor
  const vendaIniD = new Date(vendaIni + 'T00:00:00')
  const vendaFimD = new Date(vendaFim + 'T23:59:59.999')
  const vendaMap = {}
  for (const l of lancamentos) {
    if (l.tipo !== 'saida_ficha' && l.tipo !== 'saida_manual') continue
    const d = new Date(l.data)
    if (d < vendaIniD || d > vendaFimD) continue
    const ehFicha = l.tipo === 'saida_ficha'
    const nome = (ehFicha ? l.nomeFicha : l.nomeProduto) || 'Sem nome'
    const key = (ehFicha ? 'f:' : 'p:') + nome
    const qtd = l.quantidade || 0
    const valor = ehFicha ? qtd * custoDaFicha(l.ficha_id) : qtd * custoUnit(l.produto_id)
    if (!vendaMap[key]) vendaMap[key] = { key, nome, ehFicha, unidade: ehFicha ? '' : (prodMap[l.produto_id]?.unidade || ''), qtd: 0, valor: 0 }
    vendaMap[key].qtd += qtd
    vendaMap[key].valor += valor
  }
  const vendaRows = Object.values(vendaMap)
    .map(v => ({ ...v, qtd: round3(v.qtd), valor: Math.round(v.valor * 100) / 100 }))
    .filter(v => v.qtd > 0)
    .sort((a, b) => metricaVenda === 'valor' ? b.valor - a.valor : b.qtd - a.qtd)
  const vendaTotalUnid = round3(vendaRows.reduce((s, v) => s + v.qtd, 0))
  const vendaTotalValor = Math.round(vendaRows.reduce((s, v) => s + v.valor, 0) * 100) / 100
  const vendaRowsFiltrados = vendaRows.filter(v => !buscaVenda || v.nome.toLowerCase().includes(buscaVenda.toLowerCase()))
  const presetVendaDias = dias => {
    setVendaIni(fmtData(new Date(Date.now() - dias * 864e5)))
    setVendaFim(fmtData(new Date()))
  }
  const presetVendaMes = () => {
    const h = new Date()
    setVendaIni(fmtData(new Date(h.getFullYear(), h.getMonth(), 1)))
    setVendaFim(fmtData(h))
  }

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
        <button onClick={() => setMostrarVendas(true)} className="btn-secondary text-sm">🧾 Relatório de Vendas</button>
        <button onClick={() => exportarEstoqueCSV(produtos)} className="btn-secondary text-sm">📤 Estoque CSV</button>
        <button onClick={() => exportarEstoquePDF(produtos)} className="btn-secondary text-sm">📄 Estoque PDF</button>
        <button onClick={() => exportarHistoricoCSV(lancamentos)} className="btn-secondary text-sm">📤 Histórico CSV</button>
      </div>

      {/* Relatório de Contagem (período) — abre em tela própria */}
      {mostrarContagem && (
        <Modal title="📋 Relatório de Contagem" onClose={() => setMostrarContagem(false)} maxWidth="max-w-2xl">
          <div className="space-y-4">
            {/* Período: atalhos + intervalo */}
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => presetDias(7)} className="text-xs px-3 py-1 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">7 dias</button>
                <button onClick={() => presetDias(30)} className="text-xs px-3 py-1 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">30 dias</button>
                <button onClick={presetMesAtual} className="text-xs px-3 py-1 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">Este mês</button>
              </div>
              <div className="flex flex-wrap items-end gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">De</span>
                  <input type="date" value={contIni} max={contFim} onChange={e => setContIni(e.target.value)} className="input w-auto" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">Até</span>
                  <input type="date" value={contFim} min={contIni} onChange={e => setContFim(e.target.value)} className="input w-auto" />
                </label>
              </div>
            </div>

            {contRows.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-4xl mb-2">📭</p>
                <p className="text-sm text-gray-600 font-medium">Nenhum ajuste de contagem no período.</p>
                <p className="text-xs text-gray-400 mt-1">Faça uma contagem de estoque para ver o relatório aqui.</p>
              </div>
            ) : (
              <>
                {/* Destaque: perda/sobra do período */}
                <div className={`rounded-xl p-4 ${contValor < 0 ? 'bg-red-50' : 'bg-green-50'}`}>
                  <p className={`text-xs font-medium uppercase ${contValor < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {contValor < 0 ? 'Perda no período' : 'Sobra no período'}
                  </p>
                  <p className={`text-3xl font-bold ${contValor < 0 ? 'text-red-700' : 'text-green-700'}`}>{formatBRL(contValor)}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{contRows.length} insumo(s) ajustado(s)</p>
                </div>

                {/* Resumo em cards */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-red-50 p-3">
                    <p className="text-xs text-red-600 font-medium">↓ Faltando</p>
                    <p className="text-2xl font-bold text-red-700">{contFalta}</p>
                  </div>
                  <div className="rounded-xl bg-green-50 p-3">
                    <p className="text-xs text-green-600 font-medium">↑ Sobrando</p>
                    <p className="text-2xl font-bold text-green-700">{contSobra}</p>
                  </div>
                </div>

                {/* Filtro */}
                <div className="flex gap-1 bg-gray-100 rounded-lg p-1 text-sm">
                  {[['todos', 'Tudo'], ['falta', 'Só faltas'], ['sobra', 'Só sobras']].map(([v, l]) => (
                    <button
                      key={v}
                      onClick={() => setFiltroCont(v)}
                      className={`flex-1 py-1.5 rounded-md transition-colors ${filtroCont === v ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500'}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>

                {/* Busca por nome */}
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    placeholder="Buscar insumo..."
                    value={buscaCont}
                    onChange={e => setBuscaCont(e.target.value)}
                    className="input pl-9"
                  />
                </div>

                {/* Lista em cartões (rola; cabeçalho acima fica fixo) */}
                <div className="space-y-2 max-h-[45vh] overflow-y-auto -mx-1 px-1">
                  {contRowsFiltrados.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">Nenhum item encontrado.</p>
                  ) : contRowsFiltrados.map(r => (
                    <div key={r.id} className="border border-gray-200 rounded-xl p-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-800 truncate">{r.nome}</p>
                        <p className="text-xs text-gray-400 font-mono">{r.antes} → {r.depois} {r.unidade}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-sm font-semibold ${r.netD < 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {r.netD < 0 ? '↓ faltou' : '↑ sobrou'} {Math.abs(r.netD)} {r.unidade}
                        </p>
                        <p className={`text-xs font-mono ${r.rs < 0 ? 'text-red-600' : 'text-green-600'}`}>{formatBRL(r.rs)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* Relatório de Vendas (período) — abre em tela própria */}
      {mostrarVendas && (
        <Modal title="🧾 Relatório de Vendas" onClose={() => setMostrarVendas(false)} maxWidth="max-w-2xl">
          <div className="space-y-4">
            {/* Período: atalhos + intervalo */}
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => presetVendaDias(7)} className="text-xs px-3 py-1 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">7 dias</button>
                <button onClick={() => presetVendaDias(30)} className="text-xs px-3 py-1 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">30 dias</button>
                <button onClick={presetVendaMes} className="text-xs px-3 py-1 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50">Este mês</button>
              </div>
              <div className="flex flex-wrap items-end gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">De</span>
                  <input type="date" value={vendaIni} max={vendaFim} onChange={e => setVendaIni(e.target.value)} className="input w-auto" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">Até</span>
                  <input type="date" value={vendaFim} min={vendaIni} onChange={e => setVendaFim(e.target.value)} className="input w-auto" />
                </label>
              </div>
            </div>

            {vendaRows.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-4xl mb-2">🧾</p>
                <p className="text-sm text-gray-600 font-medium">Nenhuma venda no período.</p>
                <p className="text-xs text-gray-400 mt-1">Lance saídas por ficha ou importe a planilha de vendas para ver o relatório aqui.</p>
              </div>
            ) : (
              <>
                {/* Destaque: total vendido */}
                <div className="rounded-xl p-4 bg-red-50">
                  <p className="text-xs font-medium uppercase text-red-700">Itens vendidos no período</p>
                  <p className="text-3xl font-bold text-red-800">{vendaTotalUnid}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{vendaRows.length} item(ns) diferente(s) · custo total {formatBRL(vendaTotalValor)}</p>
                </div>

                {/* Métrica */}
                <div className="flex gap-1 bg-gray-100 rounded-lg p-1 text-sm">
                  {[['qtd', 'Quantidade'], ['valor', 'Custo R$']].map(([v, l]) => (
                    <button
                      key={v}
                      onClick={() => setMetricaVenda(v)}
                      className={`flex-1 py-1.5 rounded-md transition-colors ${metricaVenda === v ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500'}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>

                {/* Busca por nome */}
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    placeholder="Buscar item..."
                    value={buscaVenda}
                    onChange={e => setBuscaVenda(e.target.value)}
                    className="input pl-9"
                  />
                </div>

                {/* Lista em cartões (rola; cabeçalho acima fica fixo) */}
                <div className="space-y-2 max-h-[45vh] overflow-y-auto -mx-1 px-1">
                  {vendaRowsFiltrados.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">Nenhum item encontrado.</p>
                  ) : vendaRowsFiltrados.map(v => (
                    <div key={v.key} className="border border-gray-200 rounded-xl p-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-800 truncate">{v.ehFicha ? '🍕 ' : '📦 '}{v.nome}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-gray-800">
                          {metricaVenda === 'valor' ? formatBRL(v.valor) : `${v.qtd}${v.unidade ? ' ' + v.unidade : ''}`}
                        </p>
                        <p className="text-xs font-mono text-gray-400">
                          {metricaVenda === 'valor' ? `${v.qtd}${v.unidade ? ' ' + v.unidade : ''} vendidos` : formatBRL(v.valor)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h2 className="font-semibold text-gray-700">Top Consumo</h2>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 text-xs">
              {[['qtd', 'Qtd'], ['valor', 'R$']].map(([v, l]) => (
                <button
                  key={v}
                  onClick={() => setMetricaConsumo(v)}
                  className={`px-2.5 py-1 rounded-md transition-colors ${metricaConsumo === v ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500'}`}
                >
                  {l}
                </button>
              ))}
            </div>
            <select value={periodoConsumo} onChange={e => setPeriodoConsumo(e.target.value)} className="input w-auto text-sm py-1">
              <option value="1">Hoje</option>
              <option value="7">7 dias</option>
              <option value="30">30 dias</option>
              <option value="90">90 dias</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-4">Top 10 saídas do período (🍕 vendas + 📦 saídas manuais)</p>
        {consumoData.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-10">Nenhuma saída no período selecionado.</p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(consumoData.length * 40 + 10, 120)}>
            <BarChart data={consumoData} layout="vertical" margin={{ top: 0, right: 70, left: 10, bottom: 0 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="rotulo"
                width={130}
                tick={{ fontSize: 11 }}
                tickFormatter={t => t.length > 20 ? t.slice(0, 19) + '…' : t}
              />
              <Tooltip formatter={v => metricaConsumo === 'valor' ? formatBRL(v) : v} />
              <Bar dataKey="value" fill="#b91c1c" radius={[0, 4, 4, 0]}>
                <LabelList
                  dataKey="value"
                  position="right"
                  fill="#6b7280"
                  fontSize={11}
                  formatter={v => metricaConsumo === 'valor' ? formatBRL(v) : v}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

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
