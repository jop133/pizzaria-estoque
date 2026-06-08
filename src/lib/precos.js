// Importação de preços a partir de um arquivo xlsx (planilha de controle de estoque).
// Estrutura esperada por aba: cabeçalho nas linhas 0–3, dados a partir da linha 4.
//   Col 0  = nome do produto (INSUMOS)
//   Col 2  = unidade do item no xlsx (kg, pacote, balde…)
//   Col 19 = CUSTO — preço unitário que queremos importar
//
// Dois destinos para cada item:
//   • Tem produto no app  → atualiza o preço (média das marcas, normalizada por peso).
//   • Sem produto no app  → agrupa com outros sem-vínculo e propõe CADASTRAR um produto.
//
// SheetJS é carregado de forma lazy (só baixa quando o usuário abre um xlsx).

import { fatorUnidade } from './unidades'
import { encontrarMelhorMatch, chaveAgrupamento, sugerirNomeProduto } from './matching'

const PESO = new Set(['kg', 'g', 'l', 'ml'])
const ABAS_IGNORAR = new Set(['COMPRAS SEM NOTA FISCAL'])
const round3 = v => Math.round((v || 0) * 1000) / 1000
const novoId = () => Math.random().toString(36).slice(2)

// Categoria padrão sugerida a partir da aba de origem (editável depois).
const CATEGORIA_ABA = {
  'BEBIDAS': 'Bebida',
  'HORTIFRUTIS': 'Vegetal',
  'DESCARTÁVEIS E LIMPEZA': 'Embalagem',
}
const categoriaDaAba = aba => CATEGORIA_ABA[aba] || 'Outros'

// Lê o arquivo xlsx e retorna array de { nome, preco, unidade, aba } de todas as
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
            itens.push({ nome, preco, unidade, aba })
          }
        }
        resolve(itens)
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// Normaliza o preço do item xlsx para a unidade alvo (do produto do app ou do
// produto novo a ser criado).
//
// PRIORIDADE: o peso escrito no NOME define o tamanho da embalagem e tem
// preferência sobre a unidade da coluna do xlsx. Assim "LINGUIÇA SUÍNA 5KG" a
// R$69,90 (mesmo com a coluna marcada "KG") vira R$69,90 ÷ 5 = R$13,98/kg, e
// não é tratado como se já fosse o preço por quilo.
export function normalizarPreco(preco, nomeItem, itemUnidade, unidadeAlvo) {
  const pu = (unidadeAlvo || '').toLowerCase()
  const iu = (itemUnidade || '').toLowerCase()

  if (!PESO.has(pu)) {
    return { precoNorm: round3(preco), incerto: false, dividiu: false }
  }

  // 1) Peso no nome (ex: "2,5 KG", "500G", "5KG") → divide pelo tamanho da embalagem.
  const m = (nomeItem || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
  if (m) {
    const pesoVal = parseFloat(m[1].replace(',', '.'))
    const pesoU = m[2].toLowerCase()
    if (pesoVal) {
      return {
        precoNorm: round3(preco / (pesoVal * fatorUnidade(pesoU, pu))),
        incerto: false, dividiu: true, pesoVal, pesoU,
      }
    }
  }

  // 2) Sem peso no nome, mas item já vendido por peso (coluna KG/L) → converte proporção.
  if (PESO.has(iu)) {
    return { precoNorm: round3(preco * fatorUnidade(iu, pu)), incerto: false, dividiu: false }
  }

  // 3) Embalagem sem peso conhecido → usa preço direto e marca como incerto.
  return { precoNorm: round3(preco), incerto: true, dividiu: false }
}

// Constrói um "item de preço" (linha lida do xlsx) já normalizado para a unidade alvo.
function construirItem(raw, unidadeAlvo) {
  const n = normalizarPreco(raw.preco, raw.nome, raw.unidade, unidadeAlvo)
  return {
    id: novoId(),
    nomeOriginal: raw.nome,
    precoOriginal: raw.preco,
    unidadeOriginal: raw.unidade,
    aba: raw.aba,
    precoNorm: n.precoNorm,
    incerto: n.incerto,
    dividiu: n.dividiu,
    pesoVal: n.pesoVal,
    pesoU: n.pesoU,
  }
}

// Média dos preços normalizados (ignora incertos se houver ao menos um certo).
export function mediaPrecos(itens) {
  const validos = itens.filter(it => !it.incerto)
  const base = validos.length > 0 ? validos : itens
  if (base.length === 0) return 0
  return round3(base.reduce((s, it) => s + it.precoNorm, 0) / base.length)
}

// Unidade sugerida para um produto novo, a partir dos itens do grupo.
// Sinais discretos da coluna do xlsx (unidade/caixa/fardo) têm prioridade: um
// item "COCA-COLA LATA 350ML" marcado como UNIDADE deve virar 'un' (preço por
// lata), e não 'L'. Só quando não há sinal discreto é que o peso no nome define
// a base (kg/L), permitindo a divisão por embalagem.
function sugerirUnidade(rawItens) {
  const u0 = (rawItens[0].unidade || '').toLowerCase()
  if (u0.startsWith('unidade') || u0 === 'un') return 'un'
  if (u0.startsWith('caixa') || u0 === 'cx') return 'cx'
  if (u0.startsWith('fardo')) return 'fardo'

  for (const it of rawItens) {
    const m = (it.nome || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
    if (m) {
      const u = m[2].toLowerCase()
      if (u === 'g' || u === 'kg') return 'kg'
      if (u === 'ml' || u === 'l') return 'L'
    }
  }
  if (u0.startsWith('kg') || u0 === 'kg') return 'kg'
  if (u0.startsWith('pacote') || u0 === 'pct') return 'pct'
  return 'un'
}

// Nome sugerido: o mais "limpo" (mais curto após remover marca/peso) do grupo.
function sugerirNome(rawItens) {
  const candidatos = rawItens.map(it => sugerirNomeProduto(it.nome)).filter(Boolean)
  if (candidatos.length === 0) return sugerirNomeProduto(rawItens[0].nome) || rawItens[0].nome
  return candidatos.sort((a, b) => a.length - b.length)[0]
}

// Chave para agrupar itens SEM vínculo entre si.
// - Vendido por PESO (coluna kg/g/l/ml): tamanhos diferentes se normalizam para
//   o mesmo preço/kg → agrupa só pelo nome-base (ex: Linguiça 5KG + 1KG juntas).
// - Vendido por UNIDADE (lata, unidade, pacote…): "1 unidade" de tamanhos
//   diferentes é um produto diferente → inclui o tamanho na chave (ex: Coca lata
//   350ml ≠ Coca 2L; com gás ≠ sem gás).
function chaveBucket(raw) {
  const base = chaveAgrupamento(raw.nome) || ('__' + novoId())
  const iu = (raw.unidade || '').toLowerCase()
  if (PESO.has(iu)) return base
  const m = (raw.nome || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
  const size = m ? `${parseFloat(m[1].replace(',', '.'))}${m[2].toLowerCase()}` : ''
  return base + '|' + size
}

// Cria um grupo 'novo' (proposta de cadastro) a partir de itens brutos do xlsx
// ({ nome, preco, unidade, aba }). Reutilizado ao desvincular itens na tela.
export function criarGrupoNovo(rawItens) {
  const unidadeNova = sugerirUnidade(rawItens)
  const itens = rawItens.map(r => construirItem(r, unidadeNova))
  const media = mediaPrecos(itens)

  // Para produtos vendidos por unidade, o tamanho faz parte da identidade —
  // inclui no nome para não criar dois "Coca Cola Zero" indistinguíveis.
  let nomeNovo = sugerirNome(rawItens)
  if (!PESO.has((rawItens[0].unidade || '').toLowerCase())) {
    const m = (rawItens[0].nome || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
    if (m) nomeNovo += ` ${m[1].replace('.', ',')}${m[2].toUpperCase()}`
  }

  return {
    id: novoId(), tipo: 'novo', produtoId: null,
    nomeNovo,
    unidadeNova, categoriaNova: categoriaDaAba(rawItens[0].aba),
    confianca: 'novo', itens,
    precoCalculado: media, preco: String(media), precoEditado: false,
    confirmado: false, pulado: false,
  }
}

// Núcleo: recebe os itens do xlsx + produtos do app. Devolve grupos:
//  • tipo 'match' (produtoId definido) → atualizar preço.
//  • tipo 'novo'  (produtoId null)     → cadastrar produto (com nome/unidade/categoria sugeridos).
export function matchearPrecos(itensXlsx, produtos) {
  const gruposMatch = []
  const porProduto = new Map()
  const semMatch = []

  for (const raw of itensXlsx) {
    const { produto, confianca } = encontrarMelhorMatch(raw.nome, produtos)
    if (!produto || confianca === 'nenhuma') { semMatch.push(raw); continue }

    let g = porProduto.get(produto.id)
    if (!g) {
      g = {
        id: novoId(), tipo: 'match',
        produtoId: produto.id, produtoNome: produto.nome, produtoUnidade: produto.unidade,
        confianca, itens: [],
        precoCalculado: 0, preco: '0', precoEditado: false,
        confirmado: false, pulado: false,
      }
      porProduto.set(produto.id, g)
      gruposMatch.push(g)
    }
    if (confianca === 'media') g.confianca = 'media'
    g.itens.push(construirItem(raw, produto.unidade))
  }

  for (const g of gruposMatch) {
    g.precoCalculado = mediaPrecos(g.itens)
    g.preco = String(g.precoCalculado)
  }

  // Agrupa os sem-vínculo ENTRE SI (chave ciente do tamanho) e propõe cadastrar.
  const buckets = new Map()
  for (const raw of semMatch) {
    const chave = chaveBucket(raw)
    if (!buckets.has(chave)) buckets.set(chave, [])
    buckets.get(chave).push(raw)
  }
  const gruposNovos = [...buckets.values()].map(criarGrupoNovo)

  return [...gruposMatch, ...gruposNovos]
}
