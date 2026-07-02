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

export function exportarHistoricoCSV(lancamentos) {
  const data = lancamentos.map(l => ({
    Data: new Date(l.data).toLocaleString('pt-BR'),
    Tipo: l.tipo === 'entrada' ? 'Entrada' : l.tipo === 'saida_ficha' ? 'Saída por Ficha' : 'Saída Manual',
    Item: l.nomeFicha || l.nomeProduto || '',
    Quantidade: l.quantidade,
    Observação: l.observacao || '',
  }))
  const csv = Papa.unparse(data)
  download(csv, 'historico.csv', 'text/csv')
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
