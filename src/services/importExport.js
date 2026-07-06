import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

// Ordem canônica das categorias do estoque (igual a Estoque.jsx CATEGORIAS).
const CATEGORIAS_ORDEM = [
  'Laticínios e Frios', 'Proteínas', 'Hortifruti', 'Mercearia', 'Produções Internas',
  'Bebidas', 'Embalagens e Etiquetas', 'Limpeza', 'Porcionados', 'Outros',
]

// Cores (ARGB) e formato de moeda para o Excel.
const C_VINHO = 'FF7F1D1D'       // cabeçalho (red-900)
const C_VINHO_CLARO = 'FFF3E8E8' // subtotal
const C_ZEBRA = 'FFF9FAFB'       // linha zebrada
const C_BAIXO = 'FFDC2626'       // status BAIXO (vermelho)
const C_OK = 'FF16A34A'          // status OK (verde)
const C_CINZA = 'FF6B7280'
const FMT_RS = '"R$" #,##0.00'
const r3 = v => Math.round((v || 0) * 1000) / 1000
const r2 = v => Math.round((v || 0) * 100) / 100
const dataBR = s => { const [y, m, d] = (s || '').split('-'); return `${d}/${m}/${y}` }

const bordaFina = () => {
  const l = { style: 'thin', color: { argb: 'FFE5E7EB' } }
  return { top: l, left: l, bottom: l, right: l }
}
// Nome de aba válido no Excel (máx. 31 chars, sem : \ / ? * [ ]).
const nomeAba = s => (s || 'Outros').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31)

// Exporta o estoque como um Excel (.xlsx) organizado: uma aba por categoria
// (Insumo · Qtd · Und · Mínimo · Status · Custo · Valor) + uma aba Resumo.
// ExcelJS é carregado sob demanda para não pesar no bundle principal.
export async function exportarEstoqueXLSX(produtos) {
  const mod = await import('exceljs')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Pier Pizza & Cantina'
  wb.created = new Date()
  const dataStr = new Date().toLocaleDateString('pt-BR')

  // Agrupa por categoria; ordem = canônicas com itens, depois extras (alfabético).
  const grupos = {}
  for (const p of produtos) (grupos[p.categoria || 'Outros'] || (grupos[p.categoria || 'Outros'] = [])).push(p)
  const extras = Object.keys(grupos).filter(c => !CATEGORIAS_ORDEM.includes(c)).sort((a, b) => a.localeCompare(b))
  const ordem = [...CATEGORIAS_ORDEM.filter(c => grupos[c]), ...extras]

  // Aba Resumo criada primeiro (fica como primeira aba); preenchida no fim.
  const wsR = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 4 }] })

  const COLS = [36, 10, 12, 16, 10, 15, 16] // larguras
  const HEADERS = ['Insumo', 'Qtd', 'Und', 'Estoque mínimo', 'Status', 'Custo un. (R$)', 'Valor (R$)']
  const resumo = []
  let totalGeral = 0

  for (const cat of ordem) {
    const itens = grupos[cat].slice().sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
    const ws = wb.addWorksheet(nomeAba(cat), { views: [{ state: 'frozen', ySplit: 4 }] })
    ws.columns = COLS.map(w => ({ width: w }))

    ws.mergeCells('A1:G1')
    ws.getCell('A1').value = `Pier Pizza & Cantina — Estoque — ${cat}`
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
    ws.getRow(1).height = 22
    ws.mergeCells('A2:G2')
    ws.getCell('A2').value = `Gerado em ${dataStr}`
    ws.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }

    const hr = ws.getRow(4)
    HEADERS.forEach((h, i) => {
      const c = hr.getCell(i + 1)
      c.value = h
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
      c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' }
      c.border = bordaFina()
    })
    hr.height = 20

    let totalCat = 0
    itens.forEach((p, idx) => {
      const min = p.estoque_minimo || 0
      const qtd = p.quantidade || 0
      const baixo = qtd <= min
      const custo = p.preco || 0
      const valor = qtd * custo
      totalCat += valor
      const r = ws.getRow(5 + idx)
      const vals = [p.nome, qtd, p.unidade || '', min, baixo ? 'BAIXO' : 'OK', custo, valor]
      vals.forEach((v, ci) => {
        const c = r.getCell(ci + 1)
        c.value = v
        c.border = bordaFina()
        c.alignment = { horizontal: ci === 0 ? 'left' : 'center' }
        if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
      })
      r.getCell(6).numFmt = FMT_RS
      r.getCell(7).numFmt = FMT_RS
      r.getCell(5).font = { bold: true, color: { argb: baixo ? C_BAIXO : C_OK } }
    })

    const sr = ws.getRow(5 + itens.length)
    sr.getCell(1).value = `TOTAL ${cat} — ${itens.length} item(ns)`
    sr.getCell(7).value = totalCat
    sr.getCell(7).numFmt = FMT_RS
    for (let ci = 1; ci <= 7; ci++) {
      sr.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO_CLARO } }
      sr.getCell(ci).border = bordaFina()
      sr.getCell(ci).font = { bold: true }
    }
    sr.getCell(1).alignment = { horizontal: 'left' }
    sr.getCell(7).alignment = { horizontal: 'center' }

    resumo.push({ cat, n: itens.length, valor: totalCat })
    totalGeral += totalCat
  }

  // Preenche a aba Resumo.
  wsR.columns = [{ width: 30 }, { width: 14 }, { width: 20 }]
  wsR.mergeCells('A1:C1')
  wsR.getCell('A1').value = 'Pier Pizza & Cantina — Resumo do Estoque'
  wsR.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
  wsR.getRow(1).height = 22
  wsR.mergeCells('A2:C2')
  wsR.getCell('A2').value = `Gerado em ${dataStr}`
  wsR.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }
  const rHead = wsR.getRow(4)
  ;['Categoria', 'Nº de itens', 'Valor em estoque (R$)'].forEach((h, i) => {
    const c = rHead.getCell(i + 1)
    c.value = h
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
    c.alignment = { horizontal: i === 0 ? 'left' : 'center' }
    c.border = bordaFina()
  })
  rHead.height = 20
  resumo.forEach((x, idx) => {
    const r = wsR.getRow(5 + idx)
    const vals = [x.cat, x.n, x.valor]
    vals.forEach((v, ci) => {
      const c = r.getCell(ci + 1)
      c.value = v
      c.border = bordaFina()
      c.alignment = { horizontal: ci === 0 ? 'left' : 'center' }
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
    })
    r.getCell(3).numFmt = FMT_RS
  })
  const rTot = wsR.getRow(5 + resumo.length)
  rTot.getCell(1).value = 'TOTAL GERAL'
  rTot.getCell(2).value = resumo.reduce((s, x) => s + x.n, 0)
  rTot.getCell(3).value = totalGeral
  rTot.getCell(3).numFmt = FMT_RS
  for (let ci = 1; ci <= 3; ci++) {
    rTot.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO_CLARO } }
    rTot.getCell(ci).border = bordaFina()
    rTot.getCell(ci).font = { bold: true }
  }
  rTot.getCell(1).alignment = { horizontal: 'left' }
  ;[2, 3].forEach(ci => rTot.getCell(ci).alignment = { horizontal: 'center' })

  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const buf = await wb.xlsx.writeBuffer()
  download(buf, `estoque-pier-${ym}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}

// Exporta as vendas de um período como Excel, no mesmo estilo do estoque:
// abas "Pratos" (venda por ficha) e "Produtos" (saída manual) + "Resumo".
// `rows` = [{ nome, ehFicha, unidade, qtd, valor }] (valor = custo dos insumos).
export async function exportarVendasXLSX(rows, { ini, fim }) {
  const mod = await import('exceljs')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Pier Pizza & Cantina'
  wb.created = new Date()
  const dataStr = new Date().toLocaleDateString('pt-BR')
  const periodoStr = `${dataBR(ini)} a ${dataBR(fim)}`

  const pratos = rows.filter(r => r.ehFicha).slice().sort((a, b) => b.qtd - a.qtd)
  const produtos = rows.filter(r => !r.ehFicha).slice().sort((a, b) => b.qtd - a.qtd)

  const wsR = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 4 }] })

  // Monta uma aba de detalhe (Pratos ou Produtos). Retorna os totais p/ o Resumo.
  const construirAba = (aba, titulo, itens, comUnidade) => {
    const larguras = comUnidade ? [36, 14, 12, 15, 16] : [36, 14, 15, 16]
    const headers = comUnidade
      ? ['Item', 'Qtd vendida', 'Und', 'Custo un. (R$)', 'Custo total (R$)']
      : ['Item', 'Qtd vendida', 'Custo un. (R$)', 'Custo total (R$)']
    const nc = headers.length
    const ws = wb.addWorksheet(nomeAba(aba), { views: [{ state: 'frozen', ySplit: 4 }] })
    ws.columns = larguras.map(w => ({ width: w }))

    ws.mergeCells(1, 1, 1, nc)
    ws.getCell('A1').value = titulo
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
    ws.getRow(1).height = 22
    ws.mergeCells(2, 1, 2, nc)
    ws.getCell('A2').value = `Período: ${periodoStr} · Gerado em ${dataStr}`
    ws.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }

    const hr = ws.getRow(4)
    headers.forEach((h, i) => {
      const c = hr.getCell(i + 1)
      c.value = h
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
      c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' }
      c.border = bordaFina()
    })
    hr.height = 20

    let totCusto = 0, totQtd = 0
    const colCusto = comUnidade ? 4 : 3
    itens.forEach((it, idx) => {
      const custoUn = it.qtd ? it.valor / it.qtd : 0
      totCusto += it.valor
      totQtd += it.qtd
      const vals = comUnidade
        ? [it.nome, it.qtd, it.unidade || '', r2(custoUn), r2(it.valor)]
        : [it.nome, it.qtd, r2(custoUn), r2(it.valor)]
      const r = ws.getRow(5 + idx)
      vals.forEach((v, ci) => {
        const c = r.getCell(ci + 1)
        c.value = v
        c.border = bordaFina()
        c.alignment = { horizontal: ci === 0 ? 'left' : 'center' }
        if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
      })
      r.getCell(colCusto).numFmt = FMT_RS
      r.getCell(colCusto + 1).numFmt = FMT_RS
    })

    const sr = ws.getRow(5 + itens.length)
    sr.getCell(1).value = `TOTAL — ${itens.length} item(ns) · ${r3(totQtd)} vendidos`
    sr.getCell(nc).value = r2(totCusto)
    sr.getCell(nc).numFmt = FMT_RS
    for (let ci = 1; ci <= nc; ci++) {
      sr.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO_CLARO } }
      sr.getCell(ci).border = bordaFina()
      sr.getCell(ci).font = { bold: true }
    }
    sr.getCell(1).alignment = { horizontal: 'left' }
    sr.getCell(nc).alignment = { horizontal: 'center' }
    return { n: itens.length, qtd: r3(totQtd), custo: r2(totCusto) }
  }

  const tp = pratos.length ? construirAba('Pratos', `Pier Pizza & Cantina — Vendas (Pratos) — ${periodoStr}`, pratos, false) : { n: 0, qtd: 0, custo: 0 }
  const td = produtos.length ? construirAba('Produtos', `Pier Pizza & Cantina — Vendas (Produtos) — ${periodoStr}`, produtos, true) : { n: 0, qtd: 0, custo: 0 }

  // Aba Resumo.
  wsR.columns = [{ width: 32 }, { width: 16 }, { width: 16 }, { width: 20 }]
  wsR.mergeCells('A1:D1')
  wsR.getCell('A1').value = `Pier Pizza & Cantina — Vendas — ${periodoStr}`
  wsR.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
  wsR.getRow(1).height = 22
  wsR.mergeCells('A2:D2')
  wsR.getCell('A2').value = `Gerado em ${dataStr} · R$ = custo dos insumos (não é receita)`
  wsR.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }
  const rHead = wsR.getRow(4)
  ;['Grupo', 'Itens diferentes', 'Qtd vendida', 'Custo total (R$)'].forEach((h, i) => {
    const c = rHead.getCell(i + 1)
    c.value = h
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
    c.alignment = { horizontal: i === 0 ? 'left' : 'center' }
    c.border = bordaFina()
  })
  rHead.height = 20
  const linhasResumo = [['🍕 Pratos (ficha)', tp], ['📦 Produtos (saída manual)', td]]
  linhasResumo.forEach(([nome, t], idx) => {
    const r = wsR.getRow(5 + idx)
    const vals = [nome, t.n, t.qtd, t.custo]
    vals.forEach((v, ci) => {
      const c = r.getCell(ci + 1)
      c.value = v
      c.border = bordaFina()
      c.alignment = { horizontal: ci === 0 ? 'left' : 'center' }
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
    })
    r.getCell(4).numFmt = FMT_RS
  })
  const rTot = wsR.getRow(7)
  rTot.getCell(1).value = 'TOTAL GERAL'
  rTot.getCell(2).value = tp.n + td.n
  rTot.getCell(3).value = r3(tp.qtd + td.qtd)
  rTot.getCell(4).value = r2(tp.custo + td.custo)
  rTot.getCell(4).numFmt = FMT_RS
  for (let ci = 1; ci <= 4; ci++) {
    rTot.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO_CLARO } }
    rTot.getCell(ci).border = bordaFina()
    rTot.getCell(ci).font = { bold: true }
  }
  rTot.getCell(1).alignment = { horizontal: 'left' }
  ;[2, 3, 4].forEach(ci => rTot.getCell(ci).alignment = { horizontal: 'center' })

  const buf = await wb.xlsx.writeBuffer()
  download(buf, `vendas-pier-${ini}_a_${fim}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}

// Exporta as compras (entradas) de um período como Excel, no mesmo estilo:
// aba "Resumo" (por categoria) + "Compras" (detalhe geral) + uma aba por
// categoria (como no Estoque Excel).
// `rows` = [{ nome, categoria, unidade, qtd, valor }] (valor = custo × qtd).
export async function exportarComprasXLSX(rows, { ini, fim }) {
  const mod = await import('exceljs')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Pier Pizza & Cantina'
  wb.created = new Date()
  const dataStr = new Date().toLocaleDateString('pt-BR')
  const periodoStr = `${dataBR(ini)} a ${dataBR(fim)}`
  const itens = rows.slice().sort((a, b) => b.valor - a.valor)
  const totQtd = r3(itens.reduce((s, x) => s + x.qtd, 0))
  const totCusto = r2(itens.reduce((s, x) => s + x.valor, 0))

  // Agrupa por categoria (ordem canônica com itens; extras por último).
  const porCat = {}
  for (const it of itens) (porCat[it.categoria || 'Outros'] || (porCat[it.categoria || 'Outros'] = [])).push(it)
  const extras = Object.keys(porCat).filter(c => !CATEGORIAS_ORDEM.includes(c)).sort((a, b) => a.localeCompare(b))
  const ordemCat = [...CATEGORIAS_ORDEM.filter(c => porCat[c]), ...extras]

  const wsR = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 4 }] })

  // Monta uma aba de detalhe de compras (com ou sem a coluna Categoria).
  const construirDetalhe = (aba, titulo, lista, comCategoria) => {
    const headers = comCategoria
      ? ['Produto', 'Categoria', 'Qtd comprada', 'Und', 'Custo un. (R$)', 'Custo total (R$)']
      : ['Produto', 'Qtd comprada', 'Und', 'Custo un. (R$)', 'Custo total (R$)']
    const larguras = comCategoria ? [34, 22, 14, 10, 15, 16] : [34, 14, 10, 15, 16]
    const nc = headers.length
    const colCusto = comCategoria ? 5 : 4
    const ws = wb.addWorksheet(nomeAba(aba), { views: [{ state: 'frozen', ySplit: 4 }] })
    ws.columns = larguras.map(w => ({ width: w }))
    ws.mergeCells(1, 1, 1, nc)
    ws.getCell('A1').value = titulo
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
    ws.getRow(1).height = 22
    ws.mergeCells(2, 1, 2, nc)
    ws.getCell('A2').value = `Gerado em ${dataStr} · R$ = custo (custo atual × qtd, não é o valor da nota)`
    ws.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }
    const hr = ws.getRow(4)
    headers.forEach((h, i) => {
      const c = hr.getCell(i + 1)
      c.value = h
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
      c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' }
      c.border = bordaFina()
    })
    hr.height = 20
    let tc = 0, tq = 0
    lista.forEach((it, idx) => {
      const custoUn = it.qtd ? it.valor / it.qtd : 0
      tc += it.valor
      tq += it.qtd
      const vals = comCategoria
        ? [it.nome, it.categoria || 'Outros', it.qtd, it.unidade || '', r2(custoUn), r2(it.valor)]
        : [it.nome, it.qtd, it.unidade || '', r2(custoUn), r2(it.valor)]
      const r = ws.getRow(5 + idx)
      vals.forEach((v, ci) => {
        const c = r.getCell(ci + 1)
        c.value = v
        c.border = bordaFina()
        c.alignment = { horizontal: (ci === 0 || (comCategoria && ci === 1)) ? 'left' : 'center' }
        if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
      })
      r.getCell(colCusto).numFmt = FMT_RS
      r.getCell(colCusto + 1).numFmt = FMT_RS
    })
    const sr = ws.getRow(5 + lista.length)
    sr.getCell(1).value = `TOTAL — ${lista.length} item(ns) · ${r3(tq)} comprados`
    sr.getCell(nc).value = r2(tc)
    sr.getCell(nc).numFmt = FMT_RS
    for (let ci = 1; ci <= nc; ci++) {
      sr.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO_CLARO } }
      sr.getCell(ci).border = bordaFina()
      sr.getCell(ci).font = { bold: true }
    }
    sr.getCell(1).alignment = { horizontal: 'left' }
    sr.getCell(nc).alignment = { horizontal: 'center' }
  }

  // Aba "Compras" (todas) + uma aba por categoria.
  construirDetalhe('Compras', `Pier Pizza & Cantina — Compras — ${periodoStr}`, itens, true)
  for (const cat of ordemCat) {
    construirDetalhe(cat, `Pier Pizza & Cantina — Compras — ${cat} — ${periodoStr}`, porCat[cat], false)
  }

  // Aba Resumo (por categoria).
  const catRows = ordemCat.map(cat => ({
    cat,
    n: porCat[cat].length,
    qtd: r3(porCat[cat].reduce((s, x) => s + x.qtd, 0)),
    custo: r2(porCat[cat].reduce((s, x) => s + x.valor, 0)),
  }))
  wsR.columns = [{ width: 28 }, { width: 14 }, { width: 16 }, { width: 18 }]
  wsR.mergeCells('A1:D1')
  wsR.getCell('A1').value = `Pier Pizza & Cantina — Compras — ${periodoStr}`
  wsR.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
  wsR.getRow(1).height = 22
  wsR.mergeCells('A2:D2')
  wsR.getCell('A2').value = `Gerado em ${dataStr} · R$ = custo dos insumos (não é o valor da nota)`
  wsR.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }
  const rHead = wsR.getRow(4)
  ;['Categoria', 'Nº de itens', 'Qtd comprada', 'Custo total (R$)'].forEach((h, i) => {
    const c = rHead.getCell(i + 1)
    c.value = h
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
    c.alignment = { horizontal: i === 0 ? 'left' : 'center' }
    c.border = bordaFina()
  })
  rHead.height = 20
  catRows.forEach((x, idx) => {
    const r = wsR.getRow(5 + idx)
    ;[x.cat, x.n, r3(x.qtd), r2(x.custo)].forEach((v, ci) => {
      const c = r.getCell(ci + 1)
      c.value = v
      c.border = bordaFina()
      c.alignment = { horizontal: ci === 0 ? 'left' : 'center' }
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
    })
    r.getCell(4).numFmt = FMT_RS
  })
  const rTot = wsR.getRow(5 + catRows.length)
  rTot.getCell(1).value = 'TOTAL GERAL'
  rTot.getCell(2).value = itens.length
  rTot.getCell(3).value = r3(totQtd)
  rTot.getCell(4).value = r2(totCusto)
  rTot.getCell(4).numFmt = FMT_RS
  for (let ci = 1; ci <= 4; ci++) {
    rTot.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO_CLARO } }
    rTot.getCell(ci).border = bordaFina()
    rTot.getCell(ci).font = { bold: true }
  }
  rTot.getCell(1).alignment = { horizontal: 'left' }
  ;[2, 3, 4].forEach(ci => rTot.getCell(ci).alignment = { horizontal: 'center' })

  const buf = await wb.xlsx.writeBuffer()
  download(buf, `compras-pier-${ini}_a_${fim}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}

export function exportarEstoquePDF(produtos) {
  const doc = new jsPDF()
  doc.setFontSize(16)
  doc.text('Relatório de Estoque', 14, 15)
  doc.setFontSize(10)
  doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, 14, 22)

  autoTable(doc, {
    startY: 28,
    head: [['Nome', 'Categoria', 'Unidade', 'Qtd Atual', 'Mínimo', 'Status']],
    body: produtos.map(p => [
      p.nome,
      p.categoria || '-',
      p.unidade || '-',
      p.quantidade,
      p.estoque_minimo || 0,
      p.quantidade <= (p.estoque_minimo || 0) ? 'BAIXO' : 'OK',
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [220, 38, 38] },
  })
  doc.save('estoque.pdf')
}

// Exporta o histórico como Excel (.xlsx), no mesmo estilo das outras planilhas.
// `linhas` = [{ data:Date, tipo, grupo, item, qtd, por, obs }] (já resolvidas
// na tela: rótulo de tipo, quem fez, etc.). Uma aba cronológica + Resumo.
export async function exportarHistoricoXLSX(linhas) {
  const mod = await import('exceljs')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Pier Pizza & Cantina'
  wb.created = new Date()
  const geradoEm = new Date().toLocaleString('pt-BR')

  const rows = linhas.slice().sort((a, b) => b.data - a.data) // mais recente primeiro
  const fmtDataHora = d => d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })

  const wsR = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 4 }] })

  // Aba Histórico (cronológica).
  const headers = ['Data', 'Tipo', 'Grupo', 'Item', 'Qtd', 'Por', 'Observação']
  const larguras = [17, 14, 16, 32, 10, 18, 42]
  const ws = wb.addWorksheet('Histórico', { views: [{ state: 'frozen', ySplit: 4 }] })
  ws.columns = larguras.map(w => ({ width: w }))
  ws.mergeCells('A1:G1')
  ws.getCell('A1').value = 'Pier Pizza & Cantina — Histórico'
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
  ws.getRow(1).height = 22
  ws.mergeCells('A2:G2')
  ws.getCell('A2').value = `${rows.length} registro(s) · Gerado em ${geradoEm}`
  ws.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }
  const hr = ws.getRow(4)
  headers.forEach((h, i) => {
    const c = hr.getCell(i + 1)
    c.value = h
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
    c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' }
    c.border = bordaFina()
  })
  hr.height = 20
  rows.forEach((x, idx) => {
    const vals = [fmtDataHora(x.data), x.tipo, x.grupo, x.item, x.qtd ?? '', x.por, x.obs]
    const r = ws.getRow(5 + idx)
    vals.forEach((v, ci) => {
      const c = r.getCell(ci + 1)
      c.value = v
      c.border = bordaFina()
      c.alignment = { horizontal: ci === 3 || ci === 6 ? 'left' : 'center', wrapText: ci === 6 }
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
    })
  })

  // Aba Resumo — contagem por tipo.
  const cont = {}
  for (const x of rows) cont[x.tipo] = (cont[x.tipo] || 0) + 1
  const ordem = Object.entries(cont).sort((a, b) => b[1] - a[1])
  wsR.columns = [{ width: 22 }, { width: 22 }]
  wsR.mergeCells('A1:B1')
  wsR.getCell('A1').value = 'Pier Pizza & Cantina — Histórico (Resumo)'
  wsR.getCell('A1').font = { bold: true, size: 14, color: { argb: C_VINHO } }
  wsR.getRow(1).height = 22
  wsR.mergeCells('A2:B2')
  wsR.getCell('A2').value = `Gerado em ${geradoEm}`
  wsR.getCell('A2').font = { size: 9, italic: true, color: { argb: C_CINZA } }
  const rHead = wsR.getRow(4)
  ;['Tipo', 'Registros'].forEach((h, i) => {
    const c = rHead.getCell(i + 1)
    c.value = h
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO } }
    c.alignment = { horizontal: i === 0 ? 'left' : 'center' }
    c.border = bordaFina()
  })
  rHead.height = 20
  ordem.forEach(([tipo, n], idx) => {
    const r = wsR.getRow(5 + idx)
    ;[tipo, n].forEach((v, ci) => {
      const c = r.getCell(ci + 1)
      c.value = v
      c.border = bordaFina()
      c.alignment = { horizontal: ci === 0 ? 'left' : 'center' }
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } }
    })
  })
  const rTot = wsR.getRow(5 + ordem.length)
  rTot.getCell(1).value = 'TOTAL'
  rTot.getCell(2).value = rows.length
  for (let ci = 1; ci <= 2; ci++) {
    rTot.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_VINHO_CLARO } }
    rTot.getCell(ci).border = bordaFina()
    rTot.getCell(ci).font = { bold: true }
  }
  rTot.getCell(1).alignment = { horizontal: 'left' }
  rTot.getCell(2).alignment = { horizontal: 'center' }

  const now = new Date()
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const buf = await wb.xlsx.writeBuffer()
  download(buf, `historico-pier-${ymd}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}

export async function importarProdutosCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const orgId = session.organizacaoId
          if (!orgId) return reject(new Error('Sem organização ativa'))

          const produtos = results.data.map(row => ({
            organizacao_id: orgId,
            nome: row['Nome'] || row['nome'] || '',
            categoria: row['Categoria'] || row['categoria'] || 'Outros',
            unidade: row['Unidade'] || row['unidade'] || 'un',
            quantidade: parseFloat(row['Quantidade'] || row['quantidade'] || 0),
            estoque_minimo: parseFloat(row['Estoque Mínimo'] || row['estoque_minimo'] || row['estoqueMinimo'] || 0),
          })).filter(p => p.nome)

          const { error } = await supabase.from('produtos').insert(produtos)
          if (error) return reject(error)
          resolve(produtos.length)
        } catch (e) {
          reject(e)
        }
      },
      error: reject,
    })
  })
}

function download(content, filename, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
