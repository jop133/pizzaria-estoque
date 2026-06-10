// Leitura de uma planilha xlsx de PRODUÇÃO DE PORCIONADOS (colunas PRODUTO + MEDIDA).
// Lê todas as abas; em cada uma, acha a linha de cabeçalho "PRODUTO" e pega as
// linhas seguintes. SheetJS carregado lazy. Sem IA — leitura direta.

import { extrairPeso } from './unidades'

// Interpreta a célula de MEDIDA: "50G" → {50,'g'}; "1,5 L" → {1.5,'l'};
// "KG"/"LITRO" (sem número) → {null,'kg'|'l'}.
function parseMedida(s) {
  const txt = String(s || '').trim()
  const p = extrairPeso(txt)
  if (p) return { medida: p.valor, unidade: p.unidade }
  const low = txt.toLowerCase()
  if (low.includes('kg') || low.includes('quilo') || low.includes('kilo')) return { medida: null, unidade: 'kg' }
  if (low.includes('ml') || low.includes('mililitro')) return { medida: null, unidade: 'ml' }
  if (low.includes('litro') || low === 'l' || low === 'lt' || low === 'lts') return { medida: null, unidade: 'l' }
  if (low.includes('grama') || low === 'g' || low === 'gr' || low === 'grs') return { medida: null, unidade: 'g' }
  return { medida: null, unidade: null }
}

// Cabeçalhos/títulos que não são produto.
const IGNORAR = new Set(['produto', 'medida', ''])

export async function lerPorcionadosXlsx(file) {
  const XLSX = await import('xlsx')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' })
        const itens = []
        for (const aba of wb.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: '' })
          // Linha de cabeçalho = onde a col 0 é "PRODUTO".
          const headerIdx = rows.findIndex(r => String(r[0] || '').trim().toUpperCase() === 'PRODUTO')
          const start = headerIdx >= 0 ? headerIdx + 1 : 4
          for (let i = start; i < rows.length; i++) {
            const nome = String(rows[i][0] || '').trim()
            if (!nome || IGNORAR.has(nome.toLowerCase())) continue
            const { medida, unidade } = parseMedida(rows[i][1])
            itens.push({ nome, medida, unidade })
          }
        }
        resolve(itens)
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}
