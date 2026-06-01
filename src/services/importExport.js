import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

export function exportarEstoqueCSV(produtos) {
  const data = produtos.map(p => ({
    Nome: p.nome,
    Categoria: p.categoria || '',
    Unidade: p.unidade || '',
    'Quantidade Atual': p.quantidade,
    'Estoque Mínimo': p.estoque_minimo || 0,
    Status: p.quantidade <= (p.estoque_minimo || 0) ? 'BAIXO' : 'OK',
  }))
  const csv = Papa.unparse(data)
  download(csv, 'estoque.csv', 'text/csv')
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
