import { useState, useRef } from 'react'
import { useProdutos, useFichas } from '../hooks/useEstoque'
import { analisarImagemEstoque, prepararImagem, agruparPorTipo } from '../services/geminiVision'
import { registrarEntrada, registrarSaidaManual, registrarSaidaFicha } from '../services/estoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { expandirArquivosParaImagens } from '../lib/arquivos'
import { lerVendasXlsx } from '../lib/vendas'
import { SeletorProduto } from '../components/SeletorProduto'
import { X } from 'lucide-react'
import toast from 'react-hot-toast'

const tipoLabel = { entrada: 'Entrada', saida_ficha: 'Saída por Ficha', saida_manual: 'Saída Manual', desconhecido: 'Não identificado' }
// Finalidade do lote de fotos (escolhida pelo usuário)
const TIPOS_FOTO = [
  { value: 'entrada', label: '✅ Entrada (compra/reposição)' },
  { value: 'saida_ficha', label: '🍕 Saída por Ficha (venda)' },
  { value: 'saida_manual', label: '📦 Saída Manual (descarte/uso)' },
]
const UNIDADES_PESO = ['kg', 'g', 'l', 'ml']
const round3 = v => Math.round((v || 0) * 1000) / 1000

export function ImportarFoto() {
  const produtos = useProdutos()
  const todasFichas = useFichas()
  // Apenas fichas de prato entram na importação por foto (venda)
  const fichas = todasFichas.filter(f => (f.tipo_ficha || 'prato') === 'prato')

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '')
  const [editandoChave, setEditandoChave] = useState(!localStorage.getItem('gemini_api_key'))
  const [chaveTemp, setChaveTemp] = useState('')

  const [fila, setFila] = useState([])
  const [confirmando, setConfirmando] = useState(false)
  const [tipoLote, setTipoLote] = useState('entrada') // finalidade escolhida para as fotos
  const [picker, setPicker] = useState(null) // { linhas, tipoFoto } — seletor de vínculo do grupo
  const [pularGrupos, setPularGrupos] = useState({})    // { chave: true }
  const [confirmGrupos, setConfirmGrupos] = useState({}) // { chave: true }
  const [totaisManuais, setTotaisManuais] = useState({}) // { chave: '40.5' } override do total
  const [marcasGrupo, setMarcasGrupo] = useState({})     // { chave: 'Tio João' }
  const [ignorados, setIgnorados] = useState([])         // itens do topo pulados (configuráveis, detalhados em Opções)

  const fileRef = useRef()
  const cameraRef = useRef()
  const planilhaRef = useRef()

  function salvarChave() {
    const chave = chaveTemp.trim()
    if (chave.length < 20) return toast.error('Chave inválida. Verifique e tente novamente.')
    localStorage.setItem('gemini_api_key', chave)
    setApiKey(chave)
    setEditandoChave(false)
    toast.success('Chave salva!')
  }

  async function adicionarArquivos(e) {
    const selecionados = Array.from(e.target.files)
    e.target.value = ''
    if (!selecionados.length) return

    let files = selecionados
    const temPdf = selecionados.some(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
    if (temPdf) {
      const t = toast.loading('Lendo arquivo(s)...')
      try {
        files = await expandirArquivosParaImagens(selecionados)
      } catch (err) {
        toast.error('Não foi possível ler o PDF: ' + (err?.message || 'erro'), { duration: 6000 })
        files = selecionados.filter(f => f.type.startsWith('image/'))
      } finally {
        toast.dismiss(t)
      }
    }
    if (!files.length) return

    const novas = files.map(file => ({
      id: Math.random().toString(36).slice(2),
      url: URL.createObjectURL(file),
      file,
      status: 'aguardando',
      resultado: null,
      itens: [],
    }))
    setFila(prev => [...prev, ...novas])
  }

  function removerFoto(id) {
    setFila(prev => prev.filter(f => f.id !== id))
  }

  // Verifica se todas as palavras do nome cadastrado aparecem como palavras inteiras na busca
  function matchPorPalavras(nomeCadastrado, busca) {
    const palavrasBusca = busca.split(/\s+/)
    const palavrasCadastro = nomeCadastrado.split(/\s+/).filter(p => p.length >= 3)
    if (palavrasCadastro.length === 0) return false
    return palavrasCadastro.every(pc => palavrasBusca.some(pb => pb === pc))
  }

  function encontrarProdutoId(nomeCadastrado, nome) {
    if (nomeCadastrado) {
      const exato = produtos.find(p => p.nome.toLowerCase() === nomeCadastrado.toLowerCase())
      return exato?.id ?? null
    }
    const busca = (nome || '').toLowerCase()
    const exato = produtos.find(p => p.nome.toLowerCase() === busca)
    if (exato) return exato.id
    const parcial = produtos.find(p => matchPorPalavras(p.nome.toLowerCase(), busca))
    return parcial?.id ?? null
  }

  // Fator para converter o peso da embalagem na unidade do produto cadastrado.
  function fatorConversao(produtoU, pesoU) {
    const fatores = {
      'kg|g': 1 / 1000, 'kg|kg': 1, 'g|kg': 1000, 'g|g': 1,
      'l|ml': 1 / 1000, 'l|l': 1, 'ml|l': 1000, 'ml|ml': 1,
    }
    return fatores[`${produtoU}|${pesoU}`]
  }

  const normalizar = s => (s || '').trim().toLowerCase()

  // Unidade-base para um peso lido: g/kg -> kg, ml/l -> l. Senão null.
  function unidadeBaseDoPeso(unidadePeso) {
    const u = (unidadePeso || '').toLowerCase()
    if (u === 'g' || u === 'kg') return 'kg'
    if (u === 'ml' || u === 'l') return 'l'
    return null
  }

  // A IA leu um peso/volume de embalagem válido para este item?
  function temPeso(item) {
    const valor = parseFloat(String(item.pesoEmbalagem ?? '').replace(',', '.'))
    return !!valor && UNIDADES_PESO.includes((item.unidadeEmbalagem || '').toLowerCase())
  }

  // Unidade em que o item será contabilizado no estoque:
  // - produto já vinculado: a unidade dele.
  // - produto novo com peso lido: a unidade-base do peso (kg/l).
  // - caso contrário: a unidade lida pela IA ou 'un'.
  function unidadeAlvoDoItem(item, produtoVinculado) {
    if (produtoVinculado) return (produtoVinculado.unidade || '').toLowerCase()
    if (temPeso(item)) return unidadeBaseDoPeso(item.unidadeEmbalagem)
    return (item.unidade || 'un').toLowerCase()
  }

  // Decide como contabilizar o item e retorna { converter, precisaPeso, total }.
  function calcular(item, unidadeAlvo) {
    const u = (unidadeAlvo || '').toLowerCase()
    const count = parseFloat(item.quantidade) || 0

    if (UNIDADES_PESO.includes(u)) {
      if (temPeso(item)) {
        const valor = parseFloat(String(item.pesoEmbalagem ?? '').replace(',', '.'))
        const fator = fatorConversao(u, (item.unidadeEmbalagem || '').toLowerCase())
        if (valor && fator !== undefined) return { converter: true, precisaPeso: false, total: Math.round(count * valor * fator * 1000) / 1000 }
        return { converter: true, precisaPeso: true, total: null }
      }
      if (UNIDADES_PESO.includes((item.unidade || '').toLowerCase())) {
        return { converter: false, precisaPeso: false, total: count }
      }
      return { converter: true, precisaPeso: true, total: null }
    }
    return { converter: false, precisaPeso: false, total: count }
  }

  function encontrarFichaId(nomeCadastrado, nome) {
    if (nomeCadastrado) {
      const exato = fichas.find(f => f.nome.toLowerCase() === nomeCadastrado.toLowerCase())
      return exato?.id ?? null
    }
    const busca = (nome || '').toLowerCase()
    const exato = fichas.find(f => f.nome.toLowerCase() === busca)
    if (exato) return exato.id
    const parcial = fichas.find(f => matchPorPalavras(f.nome.toLowerCase(), busca))
    return parcial?.id ?? null
  }

  // Monta um item da revisão a partir do que a IA leu, resolvendo vínculo,
  // peso/volume e nomeBase (tipo do produto, vindo do agrupamento por texto).
  function construirItem(item, mapaBase) {
    const nomeBase = (mapaBase[(item.nome || '').trim()] || item.nome || '').trim()

    let produtoId = encontrarProdutoId(item.nomeCadastrado, item.nome)
    if (!produtoId && nomeBase) produtoId = encontrarProdutoId(null, nomeBase)
    let fichaId = encontrarFichaId(item.nomeCadastrado, item.nome)
    if (!fichaId && nomeBase) fichaId = encontrarFichaId(null, nomeBase)

    const prod = produtos.find(p => p.id === produtoId)
    const prodUnidade = (prod?.unidade || '').toLowerCase()

    let pesoEmbalagem = item.pesoEmbalagem ?? ''
    let unidadeEmbalagem = (item.unidadeEmbalagem || '').toLowerCase()
    const temExplicito = String(pesoEmbalagem).trim() !== '' && UNIDADES_PESO.includes(unidadeEmbalagem)
    if (!temExplicito) {
      const m = (item.nome || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
      if (m) {
        pesoEmbalagem = parseFloat(m[1].replace(',', '.'))
        unidadeEmbalagem = m[2].toLowerCase()
      }
    }
    if (UNIDADES_PESO.includes(prodUnidade) && !UNIDADES_PESO.includes(unidadeEmbalagem)) {
      unidadeEmbalagem = prodUnidade
    }
    let unidade = (item.unidade || 'un').toLowerCase()
    return {
      ...item,
      ativo: true,
      marca: item.marca || '',
      produtoId,
      fichaId,
      quantidade: item.quantidade ?? 1,
      pesoEmbalagem,
      unidadeEmbalagem,
      unidade,
      nomeBase,
      grupoNovo: normalizar(nomeBase), // chave estável p/ agrupar "produtos novos" do mesmo tipo
    }
  }

  // ---------------------------------------------------------------------------
  // Importação de PLANILHA de vendas (.xlsx) — sem IA. Lê os itens "prontos" do
  // topo + os sabores de Opções (ver lib/vendas.js) e injeta na mesma revisão.
  // ---------------------------------------------------------------------------
  const semAcento = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

  // Similaridade entre 2 palavras (0–1) via Levenshtein — tolera erro de
  // digitação (ex: "margerita" ~ "margherita"). tokProximo: alguma palavra de
  // `lista` é parecida com `w`?
  function levSim(a, b) {
    if (a === b) return 1
    const m = a.length, n = b.length
    if (m < 3 || n < 3) return 0
    const d = Array.from({ length: n + 1 }, (_, j) => j)
    for (let i = 1; i <= m; i++) {
      let prev = d[0]; d[0] = i
      for (let j = 1; j <= n; j++) {
        const tmp = d[j]
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = tmp
      }
    }
    return 1 - d[n] / Math.max(m, n)
  }
  const LIMIAR_TOK = 0.8 // similaridade mínima entre palavras (tolera 1-2 letras)

  // Sinônimos/equivalências explícitas (nome cru -> nome canônico da ficha/produto).
  const SINONIMOS = {
    'fritas': 'Fritas Com Maionese De Bacon',
    'ceasar': 'Salada Ceasar', 'ceaser': 'Salada Ceasar', 'salada ceaser': 'Salada Ceasar',
  }
  const aplicarSinonimo = nome => SINONIMOS[semAcento(nome)] || nome

  // Peso/volume por unidade: itens da planilha que vêm por UNIDADE mas o produto
  // é por peso (kg/l). Chave = nome canônico (após aliases), semAcento. O fator
  // de conversão (g→kg, ml→l) é resolvido em construirItem pela unidade do produto.
  const PESO_UNIDADE = {
    'limao thaiti': { peso: 100, unidade: 'g' },
    'chopp brahma claro barril 50l': { peso: 0.3, unidade: 'l' },
    'vinho do porto messias': { peso: 700, unidade: 'ml' },
    'campari': { peso: 900, unidade: 'ml' },
  }

  // Normaliza variantes de bebida: "sem açúcar"=zero; tira ruído (refrigerante,
  // antarctica, açúcar); "2 litros"/"2 l" -> "2l". Aplicado nos dois lados.
  function normVenda(nome) {
    let s = semAcento(nome)
      .replace(/sem\s+acucar/g, 'zero')
      .replace(/\bacucar(es)?\b/g, ' ')
      .replace(/\brefrigerante\b/g, ' ')
      .replace(/\bantar[ct]ica\b/g, ' ')
      .replace(/(\d+)\s*litros?\b/g, '$1l')
      .replace(/(\d+)\s*l\b/g, '$1l')
      .replace(/pierzz?it+a|pizzerit+a/g, 'pierzitta') // grafias do pierzitta (1 z, 2 z, pizzerita)
    if (/borda/.test(s)) s = s.replace(/\boriginal\b/g, ' ') // "Borda X Original" = "Borda X"
    return s.replace(/\s+/g, ' ').trim()
  }

  // Nome "base" do sabor: tira "pizza", "1/2", e marcadores de tamanho.
  function saborBase(nome) {
    return semAcento(nome)
      .replace(/\([^)]*\)/g, ' ') // tira "(P)", "(Pequeno)", notas entre parênteses
      .replace(/\bpizza\b/g, ' ').replace(/1\/2/g, ' ').replace(/\bmeia\b/g, ' ')
      .replace(/\bgrande\b|\bpequen[ao]\b/g, ' ').replace(/(^|\s)[gp](\s|$)/g, ' ')
      .replace(/\s+/g, ' ').trim()
  }
  function fichaTemTamanho(fichaNomeNorm, tamanho) {
    if (tamanho === 'G') return /(^|\s)g(\s|$)/.test(fichaNomeNorm) || /\bgrande\b/.test(fichaNomeNorm)
    if (tamanho === 'P') return /(^|\s)p(\s|$)/.test(fichaNomeNorm) || /\bpequena\b/.test(fichaNomeNorm)
    return true
  }
  // Acha a ficha do sabor NO TAMANHO certo (G/P vem da seção da planilha).
  // Só casa se for do tamanho certo — evita baixar uma "Argentina P" como "G".
  function encontrarFichaSaborTamanho(nome, tamanho) {
    const pal = saborBase(nome).split(' ').filter(Boolean)
    if (!pal.length) return null
    // Entre as fichas do TAMANHO certo, pega a de MAIOR sobreposição de sabor
    // (Jaccard + tolerância a digitação). Assim "Mozzarela" não cai na "Mozzarela
    // ao Pesto com Burrata" — cada uma pega a ficha mais parecida.
    let melhor = null, best = 0
    for (const fi of fichas) {
      const fn = semAcento(fi.nome)
      if (!fichaTemTamanho(fn, tamanho)) continue
      const ftoks = saborBase(fi.nome).split(' ').filter(Boolean)
      if (!ftoks.length) continue
      let inter = 0
      for (const w of new Set(pal)) if (ftoks.some(t => t === w || levSim(w, t) >= LIMIAR_TOK)) inter++
      const score = inter / new Set([...pal, ...ftoks]).size
      if (score > best) { best = score; melhor = fi }
    }
    return best >= 0.5 ? melhor.id : null
  }

  // Match PRECISO por nome (para não-pizza): sobreposição de tokens (Jaccard),
  // bidirecional — exige que os tokens distintivos (Lata/2L/Zero/350) batam, pra
  // não colapsar variantes de bebida. Casa contra produtos E fichas; abaixo do
  // limiar fica sem vínculo (você mapeia) em vez de cair na errada.
  const STOP_V = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'a', 'o', 'os', 'as', 'ao', 'com', 'para', 'no', 'na', 'gratis', 'unidade', 'und', 'un', 'uni', 'ml'])
  const tokensV = s => semAcento(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !STOP_V.has(w))
  function matchVendaNome(nome) {
    const tbArr = tokensV(normVenda(nome))
    const tb = new Set(tbArr)
    if (!tb.size) return null
    const cands = [
      ...produtos.map(p => ({ id: p.id, nome: p.nome, tipo: 'produto' })),
      ...fichas.map(f => ({ id: f.id, nome: f.nome, tipo: 'ficha' })),
    ]
    let melhor = null, best = 0
    for (const c of cands) {
      const tc = new Set(tokensV(normVenda(c.nome))); if (!tc.size) continue
      let inter = 0; for (const w of tc) if (tbArr.some(b => b === w || levSim(w, b) >= LIMIAR_TOK)) inter++
      const score = inter / new Set([...tc, ...tb]).size
      if (score > best) { best = score; melhor = c }
    }
    return best >= 0.5 ? melhor : null
  }

  // A ficha tem um tamanho que CONFLITA com o do item? (ficha G vs item P, etc.)
  function tamanhoConflita(fichaNome, tamanho) {
    const fn = semAcento(fichaNome)
    const g = /(^|\s)g(\s|$)/.test(fn) || /\bgrande\b/.test(fn)
    const p = /(^|\s)p(\s|$)/.test(fn) || /\bpequena\b/.test(fn)
    return (tamanho === 'G' && p && !g) || (tamanho === 'P' && g && !p)
  }

  function construirItemVenda(raw) {
    const nomeSin = aplicarSinonimo(raw.nome) // equivalências explícitas (fritas, ceasar...)
    // Injeta peso/volume por unidade quando o item precisa (limão, chopp, vinhos).
    const pesoInfo = PESO_UNIDADE[semAcento(nomeSin)]
    const base = construirItem({
      nome: nomeSin,
      quantidade: raw.quantidade,
      ...(pesoInfo ? { pesoEmbalagem: pesoInfo.peso, unidadeEmbalagem: pesoInfo.unidade } : {}),
    }, {})
    // Mostra o tamanho na revisão (ex: "Argentina (G)") sem duplicar se o nome
    // já tinha "(P)"/"(G)".
    if (raw.tamanho) base.nome = `${raw.nome.replace(/\s*\([gp]\)\s*$/i, '').trim()} (${raw.tamanho})`
    if (raw.tamanho) {
      const fichaId = encontrarFichaSaborTamanho(raw.nome, raw.tamanho)
      if (fichaId) return { ...base, fichaId, produtoId: null }
      // Sabor+tamanho falhou. O match por NOME ignora G/P, então pode cair numa
      // ficha de OUTRO tamanho — se a ficha do `base` conflita no tamanho, deixa
      // SEM vínculo (você mapeia). Itens sem tamanho na ficha (Cannoli) seguem.
      const fBase = fichas.find(f => f.id === base.fichaId)
      if (fBase && tamanhoConflita(fBase.nome, raw.tamanho)) {
        return { ...base, fichaId: null, produtoId: null }
      }
      return base
    }
    // Não-pizza (bebida/prato/borda/pierzitta): match preciso por nome (Jaccard),
    // que separa as variantes de Coca/Guaraná em vez de colapsar numa só.
    const m = matchVendaNome(nomeSin)
    return {
      ...base,
      fichaId: m && m.tipo === 'ficha' ? m.id : null,
      produtoId: m && m.tipo === 'produto' ? m.id : null,
    }
  }

  function entradaPlanilha(itensRaw, nomeArquivo) {
    const itens = itensRaw.map(construirItemVenda)
    return {
      id: Math.random().toString(36).slice(2),
      url: null,
      file: { name: nomeArquivo },
      status: 'pronto',
      resultado: { tipo: 'saida_ficha', itens },
      itens,
    }
  }

  async function importarPlanilhaVendas(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setTipoLote('saida_ficha')
    const t = toast.loading('Lendo planilha...')
    try {
      const { itens, ignorados: ign } = await lerVendasXlsx(file)
      if (!itens.length) { toast.dismiss(t); return toast.error('Nenhum item encontrado na planilha.') }
      setFila(prev => [...prev, entradaPlanilha(itens, file.name)])
      setIgnorados(prev => [...prev, ...ign])
      toast.dismiss(t)
      toast.success(`${itens.length} item(ns) lido(s). Revise antes de lançar.`)
    } catch (err) {
      toast.dismiss(t)
      toast.error('Erro ao ler a planilha: ' + (err?.message || 'verifique o arquivo'), { duration: 6000 })
    }
  }

  // Reincluir um item do topo que foi pulado (vira uma entrada própria p/ revisão).
  function incluirIgnorado(item) {
    setFila(prev => [...prev, entradaPlanilha([{ nome: item.nome, quantidade: item.quantidade }], 'incluído manualmente')])
    setIgnorados(prev => prev.filter(x => x !== item))
  }

  async function analisarTodas() {
    if (!apiKey) return toast.error('Configure a chave da API primeiro')
    const pendentes = fila.filter(f => f.status === 'aguardando')
    if (!pendentes.length) return toast.error('Nenhuma foto aguardando análise')

    const analisadas = []
    for (const foto of pendentes) {
      setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'analisando' } : f))
      try {
        const { base64, mimeType } = await prepararImagem(foto.file)
        const res = await analisarImagemEstoque(base64, mimeType, produtos, fichas, apiKey, tipoLote)
        res.tipo = tipoLote
        analisadas.push({ fotoId: foto.id, res })
      } catch (e) {
        setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'erro', erro: e.message } : f))
      }
    }

    let mapaBase = {}
    if (tipoLote !== 'saida_ficha') {
      const todosNomes = analisadas.flatMap(a => (a.res.itens || []).map(it => it.nome))
      try {
        mapaBase = await agruparPorTipo(todosNomes, apiKey)
      } catch {
        mapaBase = {}
      }
    }

    for (const { fotoId, res } of analisadas) {
      const itens = (res.itens || []).map(item => construirItem(item, mapaBase))
      setFila(prev => prev.map(f => f.id === fotoId ? { ...f, status: 'pronto', resultado: res, itens } : f))
    }
    toast.success('Análise concluída! Revise os itens antes de confirmar.')
  }

  function atualizarItem(fotoId, itemIdx, campo, valor) {
    setFila(prev => prev.map(f => {
      if (f.id !== fotoId) return f
      const itens = f.itens.map((it, i) => i === itemIdx ? { ...it, [campo]: valor } : it)
      return { ...f, itens }
    }))
  }

  // ---------------------------------------------------------------------------
  // Agrupamento dos itens lidos (por produto/ficha vinculado), como na tela de Preços.
  // ---------------------------------------------------------------------------
  const fotosProntas = fila.filter(f => f.status === 'pronto')

  function chaveDe(foto, item, idx) {
    if (item.fichaId) return { chave: `f-${item.fichaId}`, tipo: 'ficha' }
    if (item.produtoId) return { chave: `p-${item.produtoId}`, tipo: 'produto' }
    if (foto.resultado.tipo === 'entrada') return { chave: `novo-${item.grupoNovo}`, tipo: 'novo' }
    return { chave: `sem-${foto.id}-${idx}`, tipo: 'sem' }
  }

  const grupos = []
  const mapaGrupos = new Map()
  for (const foto of fotosProntas) {
    foto.itens.forEach((item, idx) => {
      const { chave, tipo } = chaveDe(foto, item, idx)
      let g = mapaGrupos.get(chave)
      if (!g) {
        g = { chave, tipo, tipoFoto: foto.resultado.tipo, produtoId: item.produtoId, fichaId: item.fichaId, linhas: [] }
        mapaGrupos.set(chave, g)
        grupos.push(g)
      }
      g.linhas.push({ foto, item, idx })
    })
  }

  // Unidade do grupo: do produto vinculado; 'un' p/ ficha; senão a do 1º item (peso/lida).
  function unidadeGrupo(g) {
    if (g.tipo === 'produto') return (produtos.find(p => p.id === g.produtoId)?.unidade || 'un').toLowerCase()
    if (g.tipo === 'ficha') return 'un'
    return unidadeAlvoDoItem(g.linhas[0].item, null)
  }
  // Cálculo de uma linha na unidade do grupo.
  function calcLinha(g, item, unidade) {
    if (g.tipo === 'ficha') return { converter: false, precisaPeso: false, total: parseFloat(item.quantidade) || 0 }
    return calcular(item, unidade)
  }
  function somaGrupo(g, unidade) {
    return round3(g.linhas.reduce((s, l) => s + (calcLinha(g, l.item, unidade).total || 0), 0))
  }

  // --- Ações dos grupos ---
  function abrirPickerGrupo(g) { setPicker({ linhas: g.linhas, tipoFoto: g.tipoFoto }) }
  function vincularLinhas(linhas, patch) {
    linhas.forEach(l => Object.entries(patch).forEach(([c, v]) => atualizarItem(l.foto.id, l.idx, c, v)))
  }
  function vincularProdutoPicker(p) {
    if (picker) vincularLinhas(picker.linhas, { fichaId: null, produtoId: p.id })
    setPicker(null)
  }
  function vincularFichaPicker(f) {
    if (picker) vincularLinhas(picker.linhas, { produtoId: null, fichaId: f.id })
    setPicker(null)
  }
  function criarNovoPicker() {
    if (picker) vincularLinhas(picker.linhas, { produtoId: null, fichaId: null })
    setPicker(null)
  }
  // Tira uma linha do grupo. Se está vinculada a produto/ficha, desvincula (vira
  // "produto novo" na entrada, ou "sem vínculo"). Se já é "produto novo", recebe
  // uma chave única para se separar dos demais do mesmo tipo.
  function desagrupar(l) {
    if (l.item.produtoId || l.item.fichaId) {
      atualizarItem(l.foto.id, l.idx, 'produtoId', null)
      atualizarItem(l.foto.id, l.idx, 'fichaId', null)
    } else {
      atualizarItem(l.foto.id, l.idx, 'grupoNovo', `solo-${Math.random().toString(36).slice(2)}`)
    }
  }
  // Edita um campo de uma linha e limpa o override do total (volta ao auto).
  function editarLinha(l, campo, valor, chave) {
    atualizarItem(l.foto.id, l.idx, campo, valor)
    setTotaisManuais(prev => {
      if (!(chave in prev)) return prev
      const n = { ...prev }; delete n[chave]; return n
    })
  }
  function editarTotal(chave, valor) { setTotaisManuais(prev => ({ ...prev, [chave]: valor })) }
  function editarNomeNovo(g, valor) { g.linhas.forEach(l => atualizarItem(l.foto.id, l.idx, 'nomeBase', valor)) }
  function togglePular(chave) {
    setPularGrupos(prev => ({ ...prev, [chave]: !prev[chave] }))
    setConfirmGrupos(prev => { const n = { ...prev }; delete n[chave]; return n })
  }
  function confirmarGrupo(chave) { setConfirmGrupos(prev => ({ ...prev, [chave]: true })) }
  // Confirma de uma vez todos os grupos JÁ vinculados a ficha/produto (não os
  // "sem vínculo"/"novo", que precisam de decisão). Útil no volume da planilha.
  function confirmarTodosVinculados() {
    setConfirmGrupos(prev => {
      const novo = { ...prev }
      grupos.forEach(g => {
        if (!pularGrupos[g.chave] && (g.tipo === 'ficha' || g.tipo === 'produto')) novo[g.chave] = true
      })
      return novo
    })
  }

  const gruposAtivos = grupos.filter(g => !pularGrupos[g.chave])
  const gruposConfirmados = gruposAtivos.filter(g => confirmGrupos[g.chave])

  async function lancarConfirmados() {
    if (!gruposConfirmados.length) return toast.error('Confirme ao menos um item para lançar')
    setConfirmando(true)
    let ok = 0, criados = 0, erros = 0
    const lancados = [] // { fotoId, idx }

    for (const g of gruposConfirmados) {
      const unidade = unidadeGrupo(g)
      const override = totaisManuais[g.chave]
      const qtd = (override != null && String(override).trim() !== '')
        ? parseFloat(String(override).replace(',', '.'))
        : somaGrupo(g, unidade)
      if (isNaN(qtd) || qtd <= 0) { erros++; continue }

      try {
        let produtoId = g.produtoId
        if (g.tipo === 'novo') {
          const nome = (g.linhas[0].item.nomeBase || g.linhas[0].item.nome || '').trim()
          const { data: novo } = await supabase.from('produtos').insert({
            organizacao_id: session.organizacaoId,
            nome, categoria: 'Outros', unidade: unidade || 'un', quantidade: 0, estoque_minimo: 0,
          }).select().single()
          produtoId = novo?.id
          if (produtoId) criados++
        }

        if (g.tipoFoto === 'entrada') {
          if (!produtoId) { erros++; continue }
          await registrarEntrada(produtoId, qtd, 'Importado por foto', marcasGrupo[g.chave] || '')
        } else if (g.tipoFoto === 'saida_ficha') {
          if (g.fichaId) await registrarSaidaFicha(g.fichaId, qtd, 'Importado por foto')
          else if (produtoId) await registrarSaidaManual(produtoId, qtd, 'Importado por foto')
          else { erros++; continue }
        } else {
          if (!produtoId) { erros++; continue }
          await registrarSaidaManual(produtoId, qtd, 'Importado por foto')
        }
        ok++
        g.linhas.forEach(l => lancados.push({ fotoId: l.foto.id, idx: l.idx }))
      } catch { erros++ }
    }

    setConfirmando(false)

    // Remove da fila as linhas lançadas; o resto continua para revisão.
    const porFoto = {}
    lancados.forEach(({ fotoId, idx }) => { (porFoto[fotoId] = porFoto[fotoId] || new Set()).add(idx) })
    setFila(prev => prev.flatMap(f => {
      const s = porFoto[f.id]
      if (!s) return [f]
      const itens = f.itens.filter((_, i) => !s.has(i))
      return itens.length ? [{ ...f, itens }] : []
    }))
    setConfirmGrupos({})
    setPularGrupos({})
    setTotaisManuais({})
    setMarcasGrupo({})

    if (ok > 0) {
      toast.success(criados > 0
        ? `${ok} lançamento(s)! ${criados} produto(s) criado(s) automaticamente.`
        : `${ok} lançamento(s) no estoque!`)
    }
    if (erros > 0) toast.error(`${erros} grupo(s) não puderam ser lançados`)
  }

  const aguardando = fila.filter(f => f.status === 'aguardando')
  const fotosErro = fila.filter(f => f.status === 'erro')
  const analisando = fila.some(f => f.status === 'analisando')
  const emRevisao = fotosProntas.length > 0
  const totalLinhas = grupos.reduce((s, g) => s + g.linhas.length, 0)

  // Render de um grupo (função chamada, não componente, p/ não perder foco dos inputs)
  function renderGrupo(g) {
    const unidade = unidadeGrupo(g)
    const produto = g.tipo === 'produto' ? produtos.find(p => p.id === g.produtoId) : null
    const ficha = g.tipo === 'ficha' ? fichas.find(f => f.id === g.fichaId) : null
    const pulado = !!pularGrupos[g.chave]
    const confirmado = !!confirmGrupos[g.chave]
    const linhasCalc = g.linhas.map(l => ({ l, ...calcLinha(g, l.item, unidade) }))
    const precisaAlgo = linhasCalc.some(x => x.precisaPeso)
    const auto = round3(linhasCalc.reduce((s, x) => s + (x.total || 0), 0))
    const totalDisplay = totaisManuais[g.chave] != null ? totaisManuais[g.chave] : String(auto)

    const cor = pulado ? 'border-gray-200 bg-gray-50 opacity-60'
      : confirmado ? 'border-green-400 bg-green-50'
        : g.tipo === 'sem' ? 'border-red-200 bg-red-50'
          : g.tipo === 'novo' ? 'border-blue-200 bg-blue-50'
            : precisaAlgo ? 'border-yellow-300 bg-yellow-50'
              : 'border-gray-200 bg-white'

    return (
      <div key={g.chave} className={`border rounded-xl p-4 space-y-3 ${cor}`}>
        {/* Cabeçalho */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {g.tipo === 'novo' ? (
              <>
                <label className="label">Criar produto novo</label>
                <input
                  className="input text-sm font-medium"
                  value={g.linhas[0].item.nomeBase || ''}
                  onChange={e => editarNomeNovo(g, e.target.value)}
                  placeholder="Nome do produto"
                />
              </>
            ) : (
              <p className="font-semibold text-gray-800 leading-tight break-words">
                {produto?.nome || ficha?.nome || g.linhas[0].item.nome}
              </p>
            )}
            <button onClick={() => abrirPickerGrupo(g)} className="text-xs text-red-700 underline mt-0.5">
              {(produto || ficha) ? 'trocar produto' : 'vincular a existente'}
            </button>
          </div>
          <span className="text-xs text-gray-400 shrink-0">{unidade}</span>
        </div>

        {/* Linhas (procedência) */}
        <div className="space-y-1.5 pl-1">
          {linhasCalc.map(({ l, converter, precisaPeso, total }) => (
            <div key={`${l.foto.id}-${l.idx}`} className="flex items-start gap-2">
              <div className="flex-1 min-w-0 space-y-1">
                <span className="text-xs text-gray-500 block truncate">{l.item.nome}</span>
                {converter ? (
                  <div className="flex items-end gap-1 flex-wrap text-xs">
                    <input type="number" min="0" step="1" className="input text-xs px-1 w-12" value={l.item.quantidade}
                      onChange={e => editarLinha(l, 'quantidade', parseFloat(e.target.value) || 0, g.chave)} />
                    <span className="pb-2 text-gray-400">×</span>
                    <input type="number" min="0" step="0.001" className="input text-xs px-1 w-14" placeholder="?" value={l.item.pesoEmbalagem}
                      onChange={e => editarLinha(l, 'pesoEmbalagem', e.target.value, g.chave)} />
                    <select className="input text-xs px-0.5 w-12" value={l.item.unidadeEmbalagem}
                      onChange={e => editarLinha(l, 'unidadeEmbalagem', e.target.value, g.chave)}>
                      {UNIDADES_PESO.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <span className="pb-2 text-gray-400">=</span>
                    <span className="pb-2 font-semibold text-gray-700">
                      {precisaPeso ? <span className="text-yellow-700">informe o peso</span> : `${total} ${unidade}`}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-xs">
                    <input type="number" min="0" step="0.001" className="input text-xs px-1 w-20" value={l.item.quantidade}
                      onChange={e => editarLinha(l, 'quantidade', parseFloat(e.target.value) || 0, g.chave)} />
                    <span className="text-gray-400">{unidade}</span>
                  </div>
                )}
              </div>
              {g.linhas.length > 1 && (
                <button onClick={() => desagrupar(l)} className="text-gray-300 hover:text-red-500 shrink-0 mt-0.5" aria-label="Desagrupar">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Total */}
        <div className="flex items-center gap-2 pl-1 pt-1 border-t border-black/10">
          <label className="text-sm text-gray-600">Total:</label>
          <input type="number" min="0" step="0.001" inputMode="decimal"
            value={totalDisplay}
            onChange={e => editarTotal(g.chave, e.target.value)}
            className="input w-28 text-base font-semibold text-right" />
          <span className="text-sm text-gray-400">{unidade}</span>
        </div>

        {/* Marca (entrada) */}
        {g.tipoFoto === 'entrada' && (
          <div className="pl-1">
            <label className="label">Marca (opcional)</label>
            <input className="input text-sm" placeholder="Ex: Tio João" value={marcasGrupo[g.chave] || ''}
              onChange={e => setMarcasGrupo(prev => ({ ...prev, [g.chave]: e.target.value }))} />
          </div>
        )}

        {/* Ações */}
        <div className="flex gap-2 pt-1">
          <button onClick={() => togglePular(g.chave)} className="btn-secondary flex-1 text-sm">
            {pulado ? 'Incluir' : 'Pular'}
          </button>
          <button onClick={() => confirmarGrupo(g.chave)} disabled={pulado}
            className={`flex-1 text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50 ${
              confirmado ? 'bg-green-600 text-white' : 'bg-red-800 hover:bg-red-900 text-white'
            }`}>
            {confirmado ? '✓ Confirmado' : 'Confirmar'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-28">
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={adicionarArquivos} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={adicionarArquivos} />
      <input ref={planilhaRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={importarPlanilhaVendas} />

      {/* ----------------------------- TELA INICIAL ----------------------------- */}
      {!emRevisao && (
        <>
          <h1 className="text-2xl font-bold text-gray-800">Lançar com Foto</h1>

          {editandoChave ? (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
              <p className="text-sm font-medium text-blue-800">🔑 Configure sua chave Groq (gratuita)</p>
              <p className="text-xs text-blue-600">Obtenha em: <span className="font-mono">console.groq.com</span></p>
              <input className="input" placeholder="gsk_..." value={chaveTemp} onChange={e => setChaveTemp(e.target.value)} />
              <button onClick={salvarChave} className="btn-primary w-full">Salvar Chave</button>
            </div>
          ) : (
            <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-3">
              <p className="text-sm text-green-700 font-medium">✅ IA configurada</p>
              <button onClick={() => { setChaveTemp(apiKey); setEditandoChave(true) }} className="text-xs text-green-600 underline">Alterar</button>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-700">Finalidade das fotos</p>
            <div className="grid grid-cols-1 gap-2">
              {TIPOS_FOTO.map(t => (
                <button
                  key={t.value}
                  onClick={() => setTipoLote(t.value)}
                  className={`p-3 rounded-xl border-2 text-left font-medium text-sm transition-all ${
                    tipoLote === t.value
                      ? 'border-red-700 bg-red-50 text-red-800'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400">Vale para todas as fotos da fila. Para tipos diferentes, faça em lotes separados.</p>
          </div>

          {analisando ? (
            <div className="bg-white border border-gray-200 rounded-xl p-8 text-center space-y-3">
              <svg className="animate-spin h-8 w-8 mx-auto text-red-700" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <p className="text-sm text-gray-600">Analisando foto(s)...</p>
            </div>
          ) : (
            <>
              <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 text-center space-y-3">
                <p className="text-4xl">📷</p>
                <p className="text-sm text-gray-500">Selecione uma ou várias fotos de uma vez</p>
                <div className="flex gap-2 justify-center flex-wrap">
                  <button onClick={() => fileRef.current.click()} className="btn-secondary text-sm">📁 Escolher arquivos</button>
                  <button onClick={() => cameraRef.current.click()} className="btn-secondary text-sm">📷 Tirar foto</button>
                </div>
              </div>

              {tipoLote === 'saida_ficha' && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center space-y-2">
                  <p className="text-sm text-green-800 font-medium">📊 Ou importe a planilha de vendas (.xlsx)</p>
                  <p className="text-xs text-green-600">Lê os itens prontos + os sabores das pizzas (Opções). Sem IA.</p>
                  <button onClick={() => planilhaRef.current.click()} className="btn-secondary text-sm">📊 Importar planilha</button>
                </div>
              )}

              {aguardando.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-600">{aguardando.length} foto(s) na fila</p>
                    <button onClick={analisarTodas} disabled={!apiKey} className="btn-primary text-sm disabled:opacity-50">
                      🔍 Analisar ({aguardando.length})
                    </button>
                  </div>
                  {aguardando.map(foto => (
                    <div key={foto.id} className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl p-2">
                      <img src={foto.url} alt="" className="w-12 h-12 object-cover rounded-lg shrink-0" />
                      <p className="flex-1 min-w-0 text-sm text-gray-700 truncate">{foto.file.name}</p>
                      <button onClick={() => removerFoto(foto.id)} className="text-gray-300 hover:text-red-500 text-lg shrink-0">✕</button>
                    </div>
                  ))}
                </div>
              )}

              {fotosErro.map(foto => (
                <p key={foto.id} className="text-xs text-red-600">
                  Erro ao ler {foto.file.name}: {foto.erro}{' '}
                  <button onClick={() => removerFoto(foto.id)} className="underline">remover</button>
                </p>
              ))}
            </>
          )}
        </>
      )}

      {/* ------------------------------- REVISÃO ------------------------------- */}
      {emRevisao && (
        <>
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-gray-800">Revisar — {tipoLabel[tipoLote]}</h1>
            <button onClick={() => { setFila([]); setIgnorados([]) }} className="text-sm text-gray-500 underline">Limpar</button>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-sm text-gray-600">
              <strong>{grupos.length}</strong> produto(s) · {totalLinhas} item(ns) lidos.
              Confira e toque em <strong>Confirmar</strong> em cada um.
            </p>
            <button onClick={confirmarTodosVinculados} className="btn-secondary w-full text-sm">✓ Confirmar todos os já vinculados</button>
            <button onClick={() => fileRef.current.click()} className="text-sm text-red-700 underline">+ Adicionar outra foto</button>
            {aguardando.length > 0 && (
              <button onClick={analisarTodas} className="btn-secondary w-full text-sm">🔍 Analisar {aguardando.length} nova(s)</button>
            )}
          </div>

          {/* Itens do topo pulados (configuráveis, detalhados em Opções) — transparência */}
          {ignorados.length > 0 && (
            <details className="bg-amber-50 border border-amber-200 rounded-xl p-3">
              <summary className="text-sm font-medium text-amber-800 cursor-pointer">
                {ignorados.length} item(ns) do topo ignorado(s) (detalhados em Opções) — toque para ver
              </summary>
              <p className="text-xs text-amber-700 mt-2 mb-1">
                São os genéricos (Pizza Grande, combos…). A baixa vem pelos sabores de Opções. Se algum não deveria ter sido pulado, toque em "incluir".
              </p>
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {ignorados.map((it, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-xs border-b border-amber-100 py-1">
                    <span className="text-gray-700 truncate">{it.nome} <span className="text-gray-400">({it.quantidade})</span></span>
                    <button onClick={() => incluirIgnorado(it)} className="text-amber-700 underline shrink-0">incluir</button>
                  </div>
                ))}
              </div>
            </details>
          )}

          {grupos.map(g => renderGrupo(g))}

          <div className="fixed bottom-16 left-0 right-0 p-3 bg-gradient-to-t from-gray-50 via-gray-50 to-transparent">
            <div className="max-w-lg mx-auto">
              <button
                onClick={lancarConfirmados}
                disabled={confirmando || gruposConfirmados.length === 0}
                className="btn-primary w-full text-base py-3 disabled:opacity-50 shadow-lg"
              >
                {confirmando ? 'Lançando...' : `Lançar ${gruposConfirmados.length} produto(s)`}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Seletor de vínculo (busca) */}
      {picker && (picker.tipoFoto === 'saida_ficha' ? (
        <SeletorProduto
          titulo="Vincular a ficha ou produto"
          produtos={[
            ...fichas.map(f => ({ id: `f-${f.id}`, nome: `🍕 ${f.nome}`, unidade: 'ficha', _ficha: f })),
            ...produtos.map(p => ({ id: `p-${p.id}`, nome: p.nome, unidade: p.unidade, _produto: p })),
          ]}
          onEscolher={c => c._ficha ? vincularFichaPicker(c._ficha) : vincularProdutoPicker(c._produto)}
          onClose={() => setPicker(null)}
        />
      ) : (
        <SeletorProduto
          titulo="Vincular a produto"
          produtos={produtos}
          descricao={p => `${p.quantidade} ${p.unidade}`}
          onEscolher={vincularProdutoPicker}
          onClose={() => setPicker(null)}
          opcaoExtra={picker.tipoFoto === 'entrada' ? { label: '+ Criar produto novo (não vincular)', onEscolher: criarNovoPicker } : undefined}
        />
      ))}
    </div>
  )
}
