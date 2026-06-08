// Matching de itens lidos de uma foto de contagem contra os produtos do app.
// Tudo aqui roda LOCAL (sem chamada à IA): a IA só lê a foto; o vínculo, o
// agrupamento (várias marcas -> 1 produto) e a soma das quantidades acontecem
// em JavaScript. Isso evita uma segunda chamada cara ao Groq e é determinístico.
//
// Estratégia de similaridade: comparação por PALAVRAS (tokens), assimétrica.
// A pontuação é a média, sobre as palavras "significativas" do PRODUTO, da
// melhor semelhança encontrada nas palavras do item da foto. Assim, ruído extra
// no nome da foto (marca, embalagem) não atrapalha — só prejudica quando uma
// palavra do produto NÃO aparece no item.

import { fatorUnidade } from './unidades'

const PESO = new Set(['kg', 'g', 'l', 'ml'])

// Palavras de embalagem/ligação que não devem "ancorar" um vínculo sozinhas.
// Mantemos números (ex: "1", "3,5") para distinguir "Catchup 1KG" de "Catchup 3,5KG".
// "com"/"sem" NÃO entram aqui de propósito: distinguem "com gás" de "sem gás",
// "com sal" de "sem sal", etc.
const STOP = new Set([
  'pacote', 'pct', 'balde', 'bisnaga', 'pote', 'unidade', 'un', 'und', 'uni',
  'lata', 'caixa', 'cx', 'garrafa', 'sache', 'vidro', 'saco', 'fardo', 'bandeja',
  'dz', 'duzia', 'kg', 'g', 'ml', 'l', 'de', 'do', 'da', 'e',
])

const round3 = v => Math.round((v || 0) * 1000) / 1000
const novoId = () => Math.random().toString(36).slice(2)

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// minúsculas, sem acento, separa número de letra ("500ml" -> "500 ml"),
// remove pontuação (preserva vírgula/ponto p/ decimais), colapsa espaços.
function normalizar(s) {
  return semAcento(s).toLowerCase()
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9,.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(s) {
  return normalizar(s).split(' ').filter(Boolean)
}

// Distância de Levenshtein (implementação local — sem dependência externa).
function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let linha = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0]
    linha[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = linha[j]
      const custo = a[i - 1] === b[j - 1] ? 0 : 1
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + custo)
      anterior = tmp
    }
  }
  return linha[b.length]
}

// Semelhança entre duas palavras (0–1). Prefixo em comum conta como forte
// (ex: "catupiry" ~ "catupiri", "capeleti" ~ "capeletti").
function tokenSim(a, b) {
  if (a === b) return 1
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.92
  const m = Math.max(a.length, b.length)
  return m ? 1 - levenshtein(a, b) / m : 0
}

// Pontuação de um produto para um item: média (sobre as palavras significativas
// do produto) da melhor semelhança achada nas palavras do item.
function pontuar(prodTokens, itemTokens) {
  const sig = prodTokens.filter(t => !STOP.has(t))
  if (!sig.length || !itemTokens.length) return 0
  let soma = 0
  for (const pt of sig) {
    let best = 0
    for (const it of itemTokens) {
      const s = tokenSim(pt, it)
      if (s > best) best = s
    }
    soma += best
  }
  return soma / sig.length
}

const LIMIAR_ALTA = 0.86
const LIMIAR_MEDIA = 0.62

function classificar(score) {
  if (score >= LIMIAR_ALTA) return 'alta'
  if (score >= LIMIAR_MEDIA) return 'media'
  return 'nenhuma'
}

// Normaliza um item lido pela IA e extrai o peso da embalagem do nome se a IA
// não tiver preenchido (ex: "OLEO 900ML" -> 900 ml).
function construirItem(raw) {
  let pesoEmbalagem = raw.pesoEmbalagem ?? ''
  let unidadeEmbalagem = (raw.unidadeEmbalagem || '').toLowerCase()
  const temExplicito = String(pesoEmbalagem).trim() !== '' && PESO.has(unidadeEmbalagem)
  if (!temExplicito) {
    const m = (raw.nome || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
    if (m) {
      pesoEmbalagem = parseFloat(m[1].replace(',', '.'))
      unidadeEmbalagem = m[2].toLowerCase()
    }
  }
  return {
    id: novoId(),
    nomeOriginal: raw.nome || '',
    quantidade: raw.quantidade ?? 0,
    unidadeOriginal: (raw.unidade || '').toLowerCase(),
    pesoEmbalagem,
    unidadeEmbalagem,
    quantidadeCalculada: 0,
    incerto: false,
  }
}

// Quantidade do item já convertida para a unidade do produto do app.
// - produto por peso + embalagem com peso -> contagem × peso (convertido).
// - produto por peso + item já em peso (peso direto) -> a própria quantidade.
// - produto por peso sem peso lido -> usa a contagem crua e marca `incerto`.
// - produto por contagem (un/pct/...) -> a própria quantidade.
export function quantidadeDoItem(item, produtoUnidade) {
  const q = parseFloat(String(item.quantidade).replace(',', '.')) || 0
  const pu = (produtoUnidade || '').toLowerCase()
  const pesoVal = parseFloat(String(item.pesoEmbalagem ?? '').replace(',', '.'))
  const pesoU = (item.unidadeEmbalagem || '').toLowerCase()
  const itemU = (item.unidadeOriginal || '').toLowerCase()

  if (PESO.has(pu)) {
    if (pesoVal > 0 && PESO.has(pesoU)) {
      return { valor: round3(q * pesoVal * fatorUnidade(pesoU, pu)), incerto: false }
    }
    if (PESO.has(itemU)) {
      return { valor: round3(q * fatorUnidade(itemU, pu)), incerto: false }
    }
    return { valor: round3(q), incerto: true }
  }
  return { valor: round3(q), incerto: false }
}

// Recalcula a quantidade de cada item de um grupo e o total (na unidade do
// produto). Não sobrescreve o total se o usuário já editou à mão.
export function recalcularGrupo(grupo, produtoUnidade) {
  const itens = grupo.itens.map(it => {
    const { valor, incerto } = quantidadeDoItem(it, produtoUnidade)
    return { ...it, quantidadeCalculada: valor, incerto }
  })
  const totalCalculado = round3(itens.reduce((s, it) => s + (it.quantidadeCalculada || 0), 0))
  return {
    ...grupo,
    itens,
    totalCalculado,
    total: grupo.totalEditado ? grupo.total : String(totalCalculado),
  }
}

function grupoSemMatch(item) {
  const itens = [{ ...item, quantidadeCalculada: parseFloat(String(item.quantidade).replace(',', '.')) || 0 }]
  return {
    id: novoId(),
    produtoId: null,
    produtoNome: '',
    produtoUnidade: '',
    confianca: 'nenhuma',
    itens,
    totalCalculado: itens[0].quantidadeCalculada,
    total: String(itens[0].quantidadeCalculada),
    totalEditado: false,
    confirmado: false,
    pulado: false,
  }
}

// Núcleo: recebe os itens lidos (de uma ou mais fotos) e a lista de produtos do
// app. Devolve os grupos prontos para a tela de confirmação, na ordem da foto.
// Itens que mapeiam para o mesmo produto são unidos no mesmo grupo (a soma das
// marcas diferentes acontece aqui). Itens sem vínculo viram grupos avulsos.
export function matchearComProdutos(itensLidos, produtos) {
  const prep = produtos.map(p => ({ p, tokens: tokens(p.nome) }))
  const grupos = []
  const porProduto = new Map()

  for (const raw of itensLidos) {
    const item = construirItem(raw)
    const itTokens = tokens(item.nomeOriginal)

    let melhor = null
    let melhorScore = 0
    for (const cand of prep) {
      const sc = pontuar(cand.tokens, itTokens)
      if (sc > melhorScore) { melhorScore = sc; melhor = cand.p }
    }
    const conf = classificar(melhorScore)

    if (conf === 'nenhuma' || !melhor) {
      grupos.push(grupoSemMatch(item))
      continue
    }

    let g = porProduto.get(melhor.id)
    if (!g) {
      g = {
        id: novoId(),
        produtoId: melhor.id,
        produtoNome: melhor.nome,
        produtoUnidade: melhor.unidade,
        confianca: conf,
        itens: [],
        totalCalculado: 0,
        total: '0',
        totalEditado: false,
        confirmado: false,
        pulado: false,
      }
      porProduto.set(melhor.id, g)
      grupos.push(g)
    }
    // O grupo fica com a MENOR confiança entre seus itens (mais cauteloso).
    if (conf === 'media') g.confianca = 'media'
    g.itens.push(item)
  }

  // Calcula as quantidades convertidas e os totais.
  return grupos.map(g => (g.produtoId ? recalcularGrupo(g, g.produtoUnidade) : g))
}

// Cria um grupo "sem vínculo" a partir de um item solto (usado ao remover um
// item de um grupo na tela de confirmação).
export function novoGrupoSemMatch(item) {
  return grupoSemMatch(item)
}

// Dado um nome, devolve o melhor produto do app e a confiança do vínculo.
// Usado por outros módulos (ex: precos.js) que precisam do matching sem a
// lógica de agrupamento por contagem.
export function encontrarMelhorMatch(nome, produtos) {
  const prep = produtos.map(p => ({ p, tokens: tokens(p.nome) }))
  const itTokens = tokens(nome)
  let melhor = null
  let melhorScore = 0
  for (const cand of prep) {
    const sc = pontuar(cand.tokens, itTokens)
    if (sc > melhorScore) { melhorScore = sc; melhor = cand.p }
  }
  return { produto: melhor, confianca: classificar(melhorScore) }
}

// Chave para agrupar itens SEM vínculo entre si (ex: "LINGUIÇA SUÍNA 5KG" e
// "LINGUIÇA SUÍNA 1KG" → mesma chave "linguica suina"). Remove marca/peso/
// embalagem (STOP) e números, deixando só as palavras significativas.
export function chaveAgrupamento(nome) {
  const sig = tokens(nome).filter(t => !STOP.has(t) && !/^\d/.test(t))
  return sig.join(' ')
}

// Sugere um nome "limpo" de produto a partir do nome bruto do xlsx: remove
// peso/volume e palavras de embalagem, tira pontuação e aplica Title Case
// (preservando acentos). Resultado é editável pelo usuário.
export function sugerirNomeProduto(nome) {
  const s = String(nome || '')
    .replace(/\d+(?:[.,]\d+)?\s*(kg|g|ml|l)\b/gi, ' ')
    .replace(/\b(pacote|pct|balde|bisnaga|pote|unidade|unid|un|und|uni|lata|caixa|cx|garrafa|sache|vidro|saco|fardo|bandeja|dz|duzia|maco|maço)\b/gi, ' ')
    .replace(/[^A-Za-zÀ-ÿ0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.split(' ').filter(Boolean)
    .map(w => w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())
    .join(' ')
}
