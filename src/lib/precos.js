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

import { fatorUnidade, extrairPeso } from './unidades'
import { encontrarMelhorMatch, chaveAgrupamento, sugerirNomeProduto } from './matching'

const PESO = new Set(['kg', 'g', 'l', 'ml'])
const ABAS_IGNORAR = new Set(['COMPRAS SEM NOTA FISCAL'])
const round3 = v => Math.round((v || 0) * 1000) / 1000
const novoId = () => Math.random().toString(36).slice(2)

// Abas cujos itens são contados por UNIDADE individual (garrafa, lata, frasco,
// embalagem descartável). Aí tamanhos diferentes são produtos diferentes
// (Coca lata 350ml ≠ Coca 2L) e o preço fica por unidade. Nas demais abas
// (ingredientes), itens de tamanhos diferentes do mesmo produto se normalizam
// por peso (kg/L) — ex: Batata Palito 2kg + 2,5kg, Catchup 400g + 1kg.
const ABAS_DISCRETAS = new Set(['BEBIDAS', 'DESCARTÁVEIS E LIMPEZA'])
const ehAbaDiscreta = aba => ABAS_DISCRETAS.has(aba)

// Nome-base do item: usa o agrupamento semântico da IA (mapaBase: nome→base,
// que remove marca/peso/embalagem mantendo o tipo). Sem IA, cai no heurístico.
function baseDe(raw, mapaBase) {
  const b = (mapaBase[(raw.nome || '').trim()] || '').trim()
  if (b) return b.toLowerCase()
  return chaveAgrupamento(raw.nome) || ('__' + novoId())
}

// Pesos distintos (normalizados a g/ml) entre os itens de um grupo. Serve para
// decidir se o produto deve ser medido por peso: marcas com tamanhos diferentes
// (2kg vs 2,5kg) → preço por kg; tamanhos iguais ou ausentes → por unidade.
function pesosDistintos(rawItens) {
  const set = new Set()
  let temVolume = false
  for (const it of rawItens) {
    const p = extrairPeso(it.nome)
    if (!p) continue
    if (p.unidade === 'ml' || p.unidade === 'l') {
      temVolume = true
      set.add('v' + Math.round(p.valor * fatorUnidade(p.unidade, 'ml')))
    } else {
      set.add('p' + Math.round(p.valor * fatorUnidade(p.unidade, 'g')))
    }
  }
  return { distintos: set.size, temVolume }
}

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

  // 1) Peso no nome (ex: "2,5 KG", "500G", "100 GRAMAS", "200GR") → divide pelo tamanho.
  const p = extrairPeso(nomeItem)
  if (p) {
    return {
      precoNorm: round3(preco / (p.valor * fatorUnidade(p.unidade, pu))),
      incerto: false, dividiu: true, pesoVal: p.valor, pesoU: p.unidade,
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

// Unidade do produto novo a partir dos itens do grupo:
// - Aba discreta (bebida/descartável) → conta por unidade/embalagem.
// - Itens com pesos DIFERENTES (2kg vs 2,5kg) → normaliza por peso (kg/L).
// - Pesos iguais ou ausentes → unidade da coluna (un/pct/cx…).
function unidadeDaColuna(raw) {
  const u = (raw.unidade || '').toLowerCase()
  if (u.startsWith('caixa') || u === 'cx') return 'cx'
  if (u.startsWith('fardo')) return 'fardo'
  if (u.startsWith('pacote') || u === 'pct') return 'pct'
  if (u.startsWith('kg') || u === 'kg') return 'kg'
  return 'un'
}
function decidirUnidade(rawItens) {
  if (!ehAbaDiscreta(rawItens[0].aba)) {
    const { distintos, temVolume } = pesosDistintos(rawItens)
    if (distintos >= 2) return temVolume ? 'L' : 'kg'
  }
  return unidadeDaColuna(rawItens[0])
}

// Nome do grupo: usa o nome-base da IA (já sem marca/peso); sem IA, cai no
// heurístico de limpeza. Aplica Title Case leve.
function nomeDoGrupo(rawItens, mapaBase) {
  const b = (mapaBase[(rawItens[0].nome || '').trim()] || '').trim()
  if (b) return sugerirNomeProduto(b) || b
  const candidatos = rawItens.map(it => sugerirNomeProduto(it.nome)).filter(Boolean)
  if (candidatos.length === 0) return sugerirNomeProduto(rawItens[0].nome) || rawItens[0].nome
  return candidatos.sort((a, b2) => a.length - b2.length)[0]
}

// Chave para agrupar itens SEM vínculo entre si, usando o nome-base da IA.
// Em abas discretas (bebida/descartável), o tamanho entra na chave para manter
// tamanhos diferentes separados (Coca 350ml ≠ Coca 2L).
function chaveBucket(raw, mapaBase) {
  const base = baseDe(raw, mapaBase)
  if (!ehAbaDiscreta(raw.aba)) return base
  const p = extrairPeso(raw.nome)
  return base + '|' + (p ? `${p.valor}${p.unidade}` : '')
}

// Cria um grupo 'novo' (proposta de cadastro) a partir de itens brutos do xlsx
// ({ nome, preco, unidade, aba }). Reutilizado ao desvincular itens na tela.
export function criarGrupoNovo(rawItens, mapaBase = {}) {
  const unidadeNova = decidirUnidade(rawItens)
  const itens = rawItens.map(r => construirItem(r, unidadeNova))
  const media = mediaPrecos(itens)

  // Em abas discretas, o tamanho faz parte da identidade — inclui no nome para
  // não criar dois "Coca Cola Zero" iguais. Por peso (agrupado) o nome-base basta.
  let nomeNovo = nomeDoGrupo(rawItens, mapaBase)
  if (ehAbaDiscreta(rawItens[0].aba)) {
    const p = extrairPeso(rawItens[0].nome)
    if (p) {
      const rotulo = { g: 'G', kg: 'KG', ml: 'ML', l: 'L' }[p.unidade] || p.unidade.toUpperCase()
      nomeNovo += ` ${String(p.valor).replace('.', ',')}${rotulo}`
    }
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

// Núcleo: recebe os itens do xlsx, os produtos do app e (opcional) o mapaBase da
// IA (nome→nome-base, para agrupar marcas). Devolve grupos:
//  • tipo 'match' → atualizar preço de produto existente.
//  • tipo 'novo'  → cadastrar produto (nome/unidade/categoria sugeridos).
export function matchearPrecos(itensXlsx, produtos, mapaBase = {}) {
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

  // Agrupa os sem-vínculo ENTRE SI pelo nome-base (IA) e propõe cadastrar.
  const buckets = new Map()
  for (const raw of semMatch) {
    const chave = chaveBucket(raw, mapaBase)
    if (!buckets.has(chave)) buckets.set(chave, [])
    buckets.get(chave).push(raw)
  }
  const gruposNovos = [...buckets.values()].map(rawItens => criarGrupoNovo(rawItens, mapaBase))

  return [...gruposMatch, ...gruposNovos]
}
