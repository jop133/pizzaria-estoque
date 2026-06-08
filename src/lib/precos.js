// Importação de preços a partir de um arquivo xlsx (planilha de controle de estoque).
// Estrutura esperada por aba: cabeçalho nas linhas 0–3, dados a partir da linha 4.
//   Col 0  = nome do produto (INSUMOS)
//   Col 2  = unidade do item no xlsx (kg, pacote, balde…)
//   Col 19 = CUSTO — preço unitário que queremos importar
//
// SheetJS é carregado de forma lazy (só baixa quando o usuário abre um xlsx),
// evitando adicionar ~300 KB ao bundle principal.

import { fatorUnidade } from './unidades'
import { encontrarMelhorMatch } from './matching'

const PESO = new Set(['kg', 'g', 'l', 'ml'])
const ABAS_IGNORAR = new Set(['COMPRAS SEM NOTA FISCAL'])
const round3 = v => Math.round((v || 0) * 1000) / 1000
const novoId = () => Math.random().toString(36).slice(2)

// Lê o arquivo xlsx e retorna array de { nome, preco, unidade } de todas as
// abas relevantes. Ignora linhas com preço vazio ou zero.
export async function lerXlsx(file) {
  const XLSX = await import('xlsx')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' })
        const itens = []
        for (const aba of wb.SheetNames) {
          if (ABAS_IGNORAR.has(aba)) continue
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: '' })
          for (let i = 4; i < rows.length; i++) {
            const row = rows[i]
            const nome = String(row[0] || '').trim()
            if (!nome) continue
            const preco = typeof row[19] === 'number'
              ? row[19]
              : parseFloat(String(row[19] || '').replace(',', '.'))
            if (!preco || preco <= 0 || isNaN(preco)) continue
            const unidade = String(row[2] || '').trim().toLowerCase()
            itens.push({ nome, preco, unidade })
          }
        }
        resolve(itens)
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// Normaliza o preço do item xlsx para a unidade do produto no app.
//
// Casos:
//  • Produto em unidade discreta (un, pct…) → preço direto, sem conversão.
//  • Item já em unidade de peso/volume      → converte pela proporção (fatorUnidade).
//  • Item em embalagem (pacote, balde…)     → extrai peso do nome e divide.
//    Ex: "BATATA PALITO UAI 2KG" a R$21,89 → 21,89 ÷ 2 = R$10,945/kg
//  • Item em embalagem sem peso no nome     → usa preço direto + marca como incerto.
export function normalizarPreco(preco, nomeItem, itemUnidade, produtoUnidade) {
  const pu = (produtoUnidade || '').toLowerCase()
  const iu = (itemUnidade || '').toLowerCase()

  if (!PESO.has(pu)) {
    return { precoNorm: round3(preco), incerto: false, dividiu: false }
  }

  if (PESO.has(iu)) {
    const fator = fatorUnidade(iu, pu)
    return { precoNorm: round3(preco * fator), incerto: false, dividiu: false }
  }

  // Embalagem: extrai peso do nome (ex: "2,5 KG", "500G")
  const m = (nomeItem || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
  if (!m) return { precoNorm: round3(preco), incerto: true, dividiu: false }

  const pesoVal = parseFloat(m[1].replace(',', '.'))
  const pesoU = m[2].toLowerCase()
  if (!pesoVal) return { precoNorm: round3(preco), incerto: true, dividiu: false }

  const fator = fatorUnidade(pesoU, pu)
  return {
    precoNorm: round3(preco / (pesoVal * fator)),
    incerto: false,
    dividiu: true,
    pesoVal,
    pesoU,
  }
}

// Constrói grupos de preço a partir dos itens do xlsx e dos produtos do app.
// Itens que mapeiam para o mesmo produto são agrupados; a média dos preços
// normalizados é calculada (ex: várias marcas de batata palito → 1 preço/kg).
export function matchearPrecos(itensXlsx, produtos) {
  const grupos = []
  const porProduto = new Map()

  for (const { nome, preco, unidade } of itensXlsx) {
    const { produto, confianca } = encontrarMelhorMatch(nome, produtos)

    const norm = produto
      ? normalizarPreco(preco, nome, unidade, produto.unidade)
      : { precoNorm: preco, incerto: false, dividiu: false }

    const item = {
      id: novoId(),
      nomeOriginal: nome,
      precoOriginal: preco,
      unidadeOriginal: unidade,
      precoNorm: norm.precoNorm,
      incerto: norm.incerto,
      dividiu: norm.dividiu,
      pesoVal: norm.pesoVal,
      pesoU: norm.pesoU,
    }

    if (!produto || confianca === 'nenhuma') {
      grupos.push({
        id: novoId(), produtoId: null, produtoNome: '', produtoUnidade: '',
        confianca: 'nenhuma', itens: [item],
        precoCalculado: preco, preco: String(preco),
        precoEditado: false, confirmado: false, pulado: false,
      })
      continue
    }

    let g = porProduto.get(produto.id)
    if (!g) {
      g = {
        id: novoId(), produtoId: produto.id, produtoNome: produto.nome,
        produtoUnidade: produto.unidade, confianca, itens: [],
        precoCalculado: 0, preco: '0', precoEditado: false,
        confirmado: false, pulado: false,
      }
      porProduto.set(produto.id, g)
      grupos.push(g)
    }
    if (confianca === 'media') g.confianca = 'media'
    g.itens.push(item)
  }

  // Média dos preços normalizados. Itens incertos entram só se todos forem incertos.
  return grupos.map(g => {
    if (!g.produtoId) return g
    const validos = g.itens.filter(it => !it.incerto)
    const base = validos.length > 0 ? validos : g.itens
    const media = round3(base.reduce((s, it) => s + it.precoNorm, 0) / base.length)
    return { ...g, precoCalculado: media, preco: String(media) }
  })
}
