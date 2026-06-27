// Leitura da planilha de VENDAS ("Itens Vendidos") do PDV — SEM IA.
// A planilha tem duas metades:
//  - TOPO (após o cabeçalho "Itens"): a venda consolidada. Mistura itens
//    "prontos" (bebidas, massas, sobremesas, pizzas de sabor fixo) com produtos
//    CONFIGURÁVEIS genéricos (Pizza Grande, Pizza Pequena, Diversos, ...).
//  - OPÇÕES (após o marcador "Opções"): o detalhamento por sabor/borda/refri
//    desses configuráveis, com meio-a-meio já contado como 0,5.
// Estratégia (Caminho A): manter os itens prontos do topo + extrair os sabores
// de Opções; PULAR os configuráveis do topo (senão conta a venda 2×).

const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n }
const limpa = s => String(s || '').trim()
const semAcento = s => limpa(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Recebe as linhas (array de arrays, header:1) e devolve { itens, ignorados }.
//  itens: [{ nome, quantidade, origem: 'topo' | 'opcoes', secao? }]
//  ignorados: [{ nome, quantidade }]  — configuráveis do topo (detalhados em Opções)
export function parseVendasRows(rows) {
  const itensIdx = rows.findIndex(r => semAcento(r[0]) === 'itens')
  const topoStart = itensIdx >= 0 ? itensIdx + 1 : 0
  let opIdx = rows.findIndex((r, i) => i > topoStart && semAcento(r[0]) === 'opcoes')
  if (opIdx < 0) opIdx = rows.length

  // 1) Seções de Opções: cabeçalhos (sem quantidade) = produtos/grupos
  //    configuráveis; sub-itens (com quantidade) = os sabores/bordas/refris.
  // O TAMANHO da pizza vem da SEÇÃO (Pizza Grande → G, Pizza Pequena → P).
  // Crucial: o mesmo sabor ("Argentina") aparece nas duas seções e mapeia para
  // fichas DIFERENTES (Argentina G ≠ Argentina P, insumos diferentes). Para
  // bordas/bebidas/pierzittas o tamanho é null (somam por nome).
  const tamanhoDaSecao = sec => {
    const s = semAcento(sec)
    if (s.includes('grande')) return 'G'
    if (s.includes('pequena')) return 'P'
    return null
  }

  const configuraveis = []
  const opcoesItens = []
  let secaoAtual = null
  for (let i = opIdx + 1; i < rows.length; i++) {
    const c0 = limpa(rows[i][0]); if (!c0) continue
    const q = num(rows[i][1])
    if (q === null) {
      if (semAcento(c0) === 'quantidade') continue // linha de cabeçalho da seção
      secaoAtual = c0
      configuraveis.push(c0)
    } else {
      opcoesItens.push({
        nome: c0.replace(/^-+\s*/, '').trim(),
        quantidade: q,
        origem: 'opcoes',
        secao: secaoAtual,
        tamanho: tamanhoDaSecao(secaoAtual), // 'G' | 'P' | null
      })
    }
  }

  // Um item do topo é "configurável" (deve ser pulado) se bate com algum
  // cabeçalho de seção de Opções — exato, ou como prefixo "<cabeçalho> ..." /
  // "<cabeçalho>-...". Ex: "Pizza Grande", "Pizza Grande - 2 sabores", "Diversos - X".
  const ehConfiguravel = nome => {
    const n = semAcento(nome)
    return configuraveis.some(h => {
      const hn = semAcento(h)
      return hn && (n === hn || n.startsWith(hn + ' ') || n.startsWith(hn + '-'))
    })
  }

  // 2) Topo: mantém os prontos; separa os configuráveis em "ignorados".
  const topoItens = []
  const ignorados = []
  for (let i = topoStart; i < opIdx; i++) {
    const c0 = limpa(rows[i][0]); const q = num(rows[i][1])
    if (!c0 || q === null || semAcento(c0) === 'itens') continue
    if (ehConfiguravel(c0)) ignorados.push({ nome: c0, quantidade: q })
    else topoItens.push({ nome: c0, quantidade: q, origem: 'topo' })
  }

  return { itens: [...topoItens, ...opcoesItens], ignorados }
}

// Lê o arquivo .xlsx (SheetJS lazy, 1ª aba) e aplica parseVendasRows.
export async function lerVendasXlsx(file) {
  const XLSX = await import('xlsx')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' })
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
        resolve(parseVendasRows(rows))
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}
