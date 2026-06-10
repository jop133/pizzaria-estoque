import { useState, useRef } from 'react'
import { useProdutos, useFichas } from '../hooks/useEstoque'
import { analisarImagemEstoque, prepararImagem, agruparPorTipo } from '../services/geminiVision'
import { registrarEntrada, registrarSaidaManual, registrarSaidaFicha } from '../services/estoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { expandirArquivosParaImagens } from '../lib/arquivos'
import { Modal } from '../components/Modal'
import { SeletorProduto } from '../components/SeletorProduto'
import toast from 'react-hot-toast'

const tipoLabel = { entrada: 'Entrada', saida_ficha: 'Saída por Ficha', saida_manual: 'Saída Manual', desconhecido: 'Não identificado' }
// Finalidade do lote de fotos (escolhida pelo usuário)
const TIPOS_FOTO = [
  { value: 'entrada', label: '✅ Entrada (compra/reposição)' },
  { value: 'saida_ficha', label: '🍕 Saída por Ficha (venda)' },
  { value: 'saida_manual', label: '📦 Saída Manual (descarte/uso)' },
]
const UNIDADES_PESO = ['kg', 'g', 'l', 'ml']
// Item "em branco" = ativo mas sem quantidade válida (vazia ou 0).
const itemEmBranco = (item) => !(parseFloat(item?.quantidade) > 0)
// Unidades oferecidas ao criar um produto novo (contagem + peso direto)
const UNIDADES_NOVO = ['un', 'pct', 'cx', 'dz', 'fardo', 'saco', 'lata', 'bandeja', 'kg', 'g', 'l', 'ml']
const ROTULO_UNIDADE = {
  un: 'Unidade (un)', pct: 'Pacote (pct)', cx: 'Caixa (cx)', dz: 'Dúzia (dz)',
  fardo: 'Fardo', saco: 'Saco', lata: 'Lata', bandeja: 'Bandeja',
  kg: 'Quilo (kg)', g: 'Grama (g)', l: 'Litro (l)', ml: 'Mililitro (ml)',
}

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
  const [modalLancar, setModalLancar] = useState(false)
  const [incluirBranco, setIncluirBranco] = useState(false)
  const [picker, setPicker] = useState(null) // { fotoId, idx, tipo } — seletor de vínculo

  const fileRef = useRef()
  const cameraRef = useRef()

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
    // Se a IA indicou nomeCadastrado, usa só correspondência exata
    if (nomeCadastrado) {
      const exato = produtos.find(p => p.nome.toLowerCase() === nomeCadastrado.toLowerCase())
      return exato?.id ?? null
    }
    const busca = (nome || '').toLowerCase()
    const exato = produtos.find(p => p.nome.toLowerCase() === busca)
    if (exato) return exato.id
    // Parcial: só aceita se todas as palavras do produto aparecem como palavras inteiras na busca
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

  // Item que será criado como produto novo: só em ENTRADA (compra/reposição).
  // Vendas e descartes apenas vinculam a produtos/fichas já existentes.
  function ehProdutoNovo(item, tipoFoto) {
    return item.ativo && !item.produtoId && !item.fichaId && tipoFoto === 'entrada'
  }

  // Quantos itens (em toda a fila) serão unidos no mesmo produto novo.
  function contarNoGrupo(baseKey) {
    let n = 0
    for (const f of fila) {
      if (f.status !== 'pronto') continue
      for (const it of f.itens) {
        if (ehProdutoNovo(it, f.resultado?.tipo) && normalizar(it.nomeBase || it.nome) === baseKey) n++
      }
    }
    return n
  }

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
  // - converter=true  -> é embalagem de um produto por peso (contagem × peso).
  //   precisaPeso=true quando falta o peso da embalagem (bloqueia até informar).
  // - converter=false -> quantidade entra direto na unidade (peso direto tipo
  //   "filé 5,466 kg", ou contagem simples como un/pct/cx).
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
      // Unidade-alvo é peso, mas sem peso de embalagem:
      // se o item já está em unidade de peso, a quantidade é o próprio peso (direto).
      if (UNIDADES_PESO.includes((item.unidade || '').toLowerCase())) {
        return { converter: false, precisaPeso: false, total: count }
      }
      // Item contado em embalagens de um produto por peso, mas peso não lido.
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

    // Vínculo: tenta pelo nome lido; se não achar, tenta pelo nomeBase (tipo).
    let produtoId = encontrarProdutoId(item.nomeCadastrado, item.nome)
    if (!produtoId && nomeBase) produtoId = encontrarProdutoId(null, nomeBase)
    let fichaId = encontrarFichaId(item.nomeCadastrado, item.nome)
    if (!fichaId && nomeBase) fichaId = encontrarFichaId(null, nomeBase)

    const prod = produtos.find(p => p.id === produtoId)
    const prodUnidade = (prod?.unidade || '').toLowerCase()

    let pesoEmbalagem = item.pesoEmbalagem ?? ''
    let unidadeEmbalagem = (item.unidadeEmbalagem || '').toLowerCase()
    // Se a IA não preencheu peso/volume explícito (comum em líquidos),
    // tenta extrair do próprio nome do item (ex: "OLEO 900ML" -> 900 ml).
    const temExplicito = String(pesoEmbalagem).trim() !== '' && UNIDADES_PESO.includes(unidadeEmbalagem)
    if (!temExplicito) {
      const m = (item.nome || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
      if (m) {
        pesoEmbalagem = parseFloat(m[1].replace(',', '.'))
        unidadeEmbalagem = m[2].toLowerCase()
      }
    }
    // Se o produto é por peso e ainda não há unidade da embalagem,
    // assume a própria unidade do produto como padrão para o usuário ajustar.
    if (UNIDADES_PESO.includes(prodUnidade) && !UNIDADES_PESO.includes(unidadeEmbalagem)) {
      unidadeEmbalagem = prodUnidade
    }
    // Normaliza a unidade do item para uma das opções conhecidas (códigos de
    // nota tipo "UNI", "PT" viram "un"); peso direto como "kg" é preservado.
    let unidade = (item.unidade || 'un').toLowerCase()
    if (!UNIDADES_NOVO.includes(unidade)) unidade = 'un'
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
    }
  }

  async function analisarTodas() {
    if (!apiKey) return toast.error('Configure a chave da API primeiro')
    const pendentes = fila.filter(f => f.status === 'aguardando')
    if (!pendentes.length) return toast.error('Nenhuma foto aguardando análise')

    // 1) Leitura por visão (uma chamada por foto) — inalterada.
    const analisadas = []
    for (const foto of pendentes) {
      setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'analisando' } : f))
      try {
        const { base64, mimeType } = await prepararImagem(foto.file)
        const res = await analisarImagemEstoque(base64, mimeType, produtos, fichas, apiKey, tipoLote)
        res.tipo = tipoLote // finalidade definida pelo usuário (não depende da IA)
        analisadas.push({ fotoId: foto.id, res })
      } catch (e) {
        setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'erro', erro: e.message } : f))
      }
    }

    // 2) Agrupamento por tipo: 1 chamada SÓ DE TEXTO para todo o lote.
    //    Só faz sentido para criar/unir produtos (entrada e saída manual).
    //    Em venda (saída por ficha) os itens casam com fichas: pular agrupamento.
    let mapaBase = {}
    if (tipoLote !== 'saida_ficha') {
      const todosNomes = analisadas.flatMap(a => (a.res.itens || []).map(it => it.nome))
      try {
        mapaBase = await agruparPorTipo(todosNomes, apiKey)
      } catch {
        mapaBase = {}
      }
    }

    // 3) Monta os itens (vínculo + peso + nomeBase) e marca as fotos como prontas.
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

  // Item "em branco"/incompleto: sem quantidade, ou produto por peso sem o peso.
  function itemIncompleto(item) {
    if (itemEmBranco(item)) return true
    if (item.fichaId) return false
    const prod = produtos.find(p => p.id === item.produtoId)
    const unidadeAlvo = unidadeAlvoDoItem(item, prod)
    const r = calcular(item, unidadeAlvo)
    return r.converter && (r.precisaPeso || !r.total)
  }

  async function confirmarTodos(incluirEmBranco = false) {
    const prontas = fila.filter(f => f.status === 'pronto')
    if (!prontas.length) return toast.error('Nenhuma foto analisada para confirmar')

    setConfirmando(true)
    let pulados = 0
    let ok = 0
    let criados = 0
    let erros = 0
    // Índices já resolvidos por foto (lançados OU pulados), para sair da fila.
    const processadosPorFoto = {}
    // Produtos novos criados nesta confirmação, por nomeBase, para unir itens
    // não cadastrados do mesmo tipo num único produto.
    const criadosPorBase = {}

    for (const foto of prontas) {
      processadosPorFoto[foto.id] = new Set()
      for (let i = 0; i < foto.itens.length; i++) {
        const item = foto.itens[i]
        if (!item.ativo) continue
        // Item em branco/incompleto: sem a opção marcada, pula e sai da fila.
        if (itemIncompleto(item) && !incluirEmBranco) {
          pulados++
          processadosPorFoto[foto.id].add(i)
          continue
        }
        try {
          let produtoId = item.produtoId
          let fichaId = item.fichaId
          const vaiCriar = !produtoId && !fichaId && foto.resultado.tipo === 'entrada'

          // Unidade em que o item será contabilizado (produto existente, novo
          // com peso, ou unidade simples). Definida ANTES de criar o produto.
          let unidadeAlvo
          if (produtoId) {
            unidadeAlvo = (produtos.find(p => p.id === produtoId)?.unidade || '').toLowerCase()
          } else if (vaiCriar) {
            unidadeAlvo = unidadeAlvoDoItem(item, null)
          }

          // Total que vai para o estoque: embalagem×peso (quando aplicável) ou a
          // própria quantidade. Se faltar o peso e o usuário optou por lançar
          // mesmo assim, usa a quantidade crua (sem conversão).
          let quantidadeFinal = parseFloat(item.quantidade) || 0
          if (!fichaId) {
            const { converter, precisaPeso, total } = calcular(item, unidadeAlvo)
            if (converter && (precisaPeso || !total)) {
              quantidadeFinal = parseFloat(item.quantidade) || 0
            } else {
              quantidadeFinal = total
            }
          }

          if (vaiCriar) {
            const baseKey = normalizar(item.nomeBase || item.nome)
            if (criadosPorBase[baseKey]) {
              // Já criado nesta confirmação por outro item do mesmo tipo: reaproveita.
              produtoId = criadosPorBase[baseKey]
            } else {
              const nomeNovo = (item.nomeBase || item.nome || '').trim()
              const { data: novo } = await supabase.from('produtos').insert({
                organizacao_id: session.organizacaoId,
                nome: nomeNovo,
                categoria: 'Outros',
                unidade: unidadeAlvo || 'un',
                quantidade: 0,
                estoque_minimo: 0,
              }).select().single()
              produtoId = novo?.id
              if (produtoId) criadosPorBase[baseKey] = produtoId
              criados++
            }
          }

          if (foto.resultado.tipo === 'entrada') {
            if (!produtoId) { erros++; continue }
            await registrarEntrada(produtoId, quantidadeFinal, 'Importado por foto', item.marca || '')
          } else if (foto.resultado.tipo === 'saida_ficha') {
            if (fichaId) await registrarSaidaFicha(fichaId, quantidadeFinal, 'Importado por foto')
            else if (produtoId) await registrarSaidaManual(produtoId, quantidadeFinal, 'Importado por foto')
            else { erros++; continue }
          } else {
            if (!produtoId) { erros++; continue }
            await registrarSaidaManual(produtoId, quantidadeFinal, 'Importado por foto')
          }
          ok++
          processadosPorFoto[foto.id].add(i)
        } catch { erros++ }
      }
    }

    setConfirmando(false)

    // Remove da fila os itens já resolvidos (lançados ou pulados em branco);
    // o que sobrou (ex: sem vínculo) continua para revisão.
    setFila(prev => prev.flatMap(f => {
      const proc = processadosPorFoto[f.id]
      if (!proc) return [f]
      const itens = f.itens.filter((it, i) => !proc.has(i))
      if (itens.length === 0) return []
      return [{ ...f, itens }]
    }))

    if (ok > 0) {
      const msg = criados > 0 ? `${ok} item(ns) lançado(s)! ${criados} produto(s) criado(s) automaticamente.` : `${ok} item(ns) lançado(s) no estoque!`
      toast.success(msg)
    }
    if (erros > 0) toast.error(`${erros} item(ns) não puderam ser lançados (sem vínculo)`)
    if (pulados > 0) toast(`${pulados} item(ns) em branco foram retirados da fila`, { icon: '⬜' })
  }

  // Helpers do seletor de vínculo (busca)
  function abrirPicker(fotoId, idx, tipo) { setPicker({ fotoId, idx, tipo }) }
  function vincularProdutoPicker(p) {
    if (!picker) return
    atualizarItem(picker.fotoId, picker.idx, 'fichaId', null)
    atualizarItem(picker.fotoId, picker.idx, 'produtoId', p.id)
    setPicker(null)
  }
  function vincularFichaPicker(f) {
    if (!picker) return
    atualizarItem(picker.fotoId, picker.idx, 'produtoId', null)
    atualizarItem(picker.fotoId, picker.idx, 'fichaId', f.id)
    setPicker(null)
  }
  function criarNovoPicker() {
    if (!picker) return
    atualizarItem(picker.fotoId, picker.idx, 'produtoId', null)
    atualizarItem(picker.fotoId, picker.idx, 'fichaId', null)
    setPicker(null)
  }

  const totalProntas = fila.filter(f => f.status === 'pronto').length
  const totalItensAtivos = fila.filter(f => f.status === 'pronto').reduce((s, f) => s + f.itens.filter(i => i.ativo).length, 0)
  const totalEmBranco = fila.filter(f => f.status === 'pronto').reduce((s, f) => s + f.itens.filter(i => i.ativo && itemIncompleto(i)).length, 0)

  const fotosProntas = fila.filter(f => f.status === 'pronto')
  const aguardando = fila.filter(f => f.status === 'aguardando')
  const fotosErro = fila.filter(f => f.status === 'erro')
  const analisando = fila.some(f => f.status === 'analisando')
  const emRevisao = totalProntas > 0
  const totalItens = fotosProntas.reduce((s, f) => s + f.itens.length, 0)

  // Card de um item lido (na revisão). É uma função de render (chamada direto no
  // map, NÃO usada como <Componente/>) para o React não remontar a cada tecla.
  function renderItem(foto, item, i) {
    const produtoVinculado = produtos.find(p => p.id === item.produtoId)
    const fichaVinculada = fichas.find(f => f.id === item.fichaId)
    const vinculo = fichaVinculada || produtoVinculado
    const unidadeAlvo = unidadeAlvoDoItem(item, produtoVinculado)
    const ehNovoEntrada = !vinculo && foto.resultado.tipo === 'entrada'
    const r = (!fichaVinculada && foto.resultado.tipo !== 'saida_ficha') ? calcular(item, unidadeAlvo) : { converter: false, precisaPeso: false, total: null }
    const usaPeso = r.converter
    const precisaPeso = r.precisaPeso
    const total = r.total
    const incompleto = item.ativo && itemIncompleto(item)
    const cor = !item.ativo ? 'border-gray-200 bg-gray-50 opacity-60'
      : incompleto ? 'border-yellow-300 bg-yellow-50'
        : vinculo ? 'border-green-300 bg-green-50'
          : ehNovoEntrada ? 'border-blue-200 bg-blue-50'
            : 'border-red-200 bg-red-50'
    const icone = !item.ativo ? '⬜' : incompleto ? '?' : vinculo ? '✓' : ehNovoEntrada ? '+' : '✕'

    return (
      <div key={`${foto.id}-${i}`} className={`border rounded-xl p-4 space-y-3 ${cor}`}>
        <div className="flex items-start gap-2">
          <span className="text-lg font-bold shrink-0">{icone}</span>
          <p className="flex-1 min-w-0 font-semibold text-gray-800 leading-tight break-words">{item.nome}</p>
          <button onClick={() => atualizarItem(foto.id, i, 'ativo', !item.ativo)} className="text-xs underline text-gray-500 shrink-0">
            {item.ativo ? 'Pular' : 'Incluir'}
          </button>
        </div>

        {item.ativo && (
          <>
            {/* Vínculo / criar novo */}
            {ehNovoEntrada ? (
              <div className="pl-7 space-y-2">
                <div>
                  <label className="label">Criar como (itens do mesmo tipo são unidos)</label>
                  <input
                    className="input text-sm"
                    placeholder="Ex: Queijo Mussarela"
                    value={item.nomeBase || ''}
                    onChange={e => atualizarItem(foto.id, i, 'nomeBase', e.target.value)}
                  />
                  {(() => {
                    const n = contarNoGrupo(normalizar(item.nomeBase || item.nome))
                    return n > 1
                      ? <p className="text-xs text-blue-600 mt-1">🔗 será unido com {n - 1} outro(s) deste tipo</p>
                      : <p className="text-xs text-gray-400 mt-1">novo produto</p>
                  })()}
                </div>
                <button onClick={() => abrirPicker(foto.id, i, 'entrada')} className="text-xs text-red-700 underline">
                  vincular a produto existente
                </button>
              </div>
            ) : (
              <div className="pl-7 flex items-center gap-2 text-sm">
                {vinculo
                  ? <span className="text-green-700 truncate">✓ {vinculo.nome}</span>
                  : <span className="text-red-600">Sem vínculo</span>}
                <button onClick={() => abrirPicker(foto.id, i, foto.resultado.tipo)} className="text-xs text-red-700 underline ml-auto shrink-0">
                  {vinculo ? 'trocar' : 'vincular'}
                </button>
              </div>
            )}

            {/* Quantidade / peso */}
            <div className="pl-7">
              {usaPeso ? (
                <div className="flex items-end gap-1.5 flex-wrap">
                  <div className="w-16">
                    <label className="label">Qtd</label>
                    <input type="number" min="0" step="1" className="input text-sm px-2" value={item.quantidade}
                      onChange={e => atualizarItem(foto.id, i, 'quantidade', parseFloat(e.target.value) || 0)} />
                  </div>
                  <span className="pb-2 text-gray-400 text-sm">×</span>
                  <div className="w-20">
                    <label className="label">Peso/un</label>
                    <input type="number" min="0" step="0.001" className="input text-sm px-2" placeholder="?" value={item.pesoEmbalagem}
                      onChange={e => atualizarItem(foto.id, i, 'pesoEmbalagem', e.target.value)} />
                  </div>
                  <div className="w-16">
                    <label className="label">Un</label>
                    <select className="input text-sm px-1" value={item.unidadeEmbalagem}
                      onChange={e => atualizarItem(foto.id, i, 'unidadeEmbalagem', e.target.value)}>
                      {UNIDADES_PESO.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <span className="pb-2 text-gray-400 text-sm">=</span>
                  <div className="pb-2 text-sm font-semibold text-gray-700">
                    {precisaPeso ? <span className="text-yellow-700">informe o peso</span> : `${total} ${unidadeAlvo}`}
                  </div>
                </div>
              ) : ehNovoEntrada ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label">Quantidade</label>
                    <input type="number" min="0.001" step="0.001" className="input text-sm" value={item.quantidade}
                      onChange={e => atualizarItem(foto.id, i, 'quantidade', parseFloat(e.target.value) || 0)} />
                  </div>
                  <div>
                    <label className="label">Unidade</label>
                    <select className="input text-sm" value={item.unidade}
                      onChange={e => atualizarItem(foto.id, i, 'unidade', e.target.value)}>
                      {UNIDADES_NOVO.map(u => <option key={u} value={u}>{ROTULO_UNIDADE[u] || u}</option>)}
                    </select>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="label">Quantidade</label>
                  <input type="number" min="0.001" step="0.001" className="input text-sm" value={item.quantidade}
                    onChange={e => atualizarItem(foto.id, i, 'quantidade', parseFloat(e.target.value) || 0)} />
                </div>
              )}
            </div>

            {/* Marca (entrada) */}
            {foto.resultado.tipo === 'entrada' && (
              <div className="pl-7">
                <label className="label">Marca (opcional)</label>
                <input className="input text-sm" placeholder="Ex: Tio João" value={item.marca || ''}
                  onChange={e => atualizarItem(foto.id, i, 'marca', e.target.value)} />
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-28">
      {/* Inputs de arquivo (sempre montados) */}
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={adicionarArquivos} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={adicionarArquivos} />

      {/* ----------------------------- TELA INICIAL ----------------------------- */}
      {!emRevisao && (
        <>
          <h1 className="text-2xl font-bold text-gray-800">Lançar com IA</h1>

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
            <button onClick={() => setFila([])} className="text-sm text-gray-500 underline">Limpar</button>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-sm text-gray-600">
              <strong>{totalItens}</strong> item(ns) lidos. Confira os vínculos e quantidades antes de lançar.
            </p>
            {totalEmBranco > 0 && (
              <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1">
                ⚠️ {totalEmBranco} item(ns) em branco (sem quantidade ou sem peso).
              </p>
            )}
            <button onClick={() => fileRef.current.click()} className="text-sm text-red-700 underline">+ Adicionar outra foto</button>
            {aguardando.length > 0 && (
              <button onClick={analisarTodas} className="btn-secondary w-full text-sm">🔍 Analisar {aguardando.length} nova(s)</button>
            )}
          </div>

          {fotosProntas.flatMap(foto =>
            foto.itens.map((item, i) => renderItem(foto, item, i))
          )}

          <div className="fixed bottom-16 left-0 right-0 p-3 bg-gradient-to-t from-gray-50 via-gray-50 to-transparent">
            <div className="max-w-lg mx-auto">
              <button
                onClick={() => { setIncluirBranco(false); setModalLancar(true) }}
                disabled={confirmando || totalItensAtivos === 0}
                className="btn-primary w-full text-base py-3 disabled:opacity-50 shadow-lg"
              >
                {confirmando ? 'Lançando...' : `Lançar ${totalItensAtivos} item(ns)`}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Modal: confirmar lançamento (itens em branco) */}
      {modalLancar && (
        <Modal title="Confirmar lançamento" onClose={() => setModalLancar(false)}>
          <div className="space-y-4">
            {totalEmBranco > 0 ? (
              <>
                <div className="flex gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <span className="text-yellow-600">⬜</span>
                  <p className="text-sm text-yellow-800">
                    <strong>{totalEmBranco} item(ns) estão em branco</strong> (sem quantidade ou sem peso).
                    {incluirBranco
                      ? ' Eles TAMBÉM serão lançados.'
                      : ' Ao prosseguir, eles NÃO serão lançados e sairão da fila.'}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={incluirBranco}
                    onChange={e => setIncluirBranco(e.target.checked)}
                    className="w-4 h-4 accent-red-700"
                  />
                  Também lançar itens em branco?
                </label>
              </>
            ) : (
              <p className="text-sm text-gray-700">Confirmar o lançamento de <strong>{totalItensAtivos} item(ns)</strong>?</p>
            )}

            <div className="flex gap-2 pt-1">
              <button onClick={() => setModalLancar(false)} className="btn-secondary flex-1">Voltar</button>
              <button
                onClick={() => { setModalLancar(false); confirmarTodos(incluirBranco) }}
                className="btn-primary flex-1"
              >
                Prosseguir
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Seletor de vínculo (busca) */}
      {picker && (picker.tipo === 'saida_ficha' ? (
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
          opcaoExtra={picker.tipo === 'entrada' ? { label: '+ Criar produto novo (não vincular)', onEscolher: criarNovoPicker } : undefined}
        />
      ))}
    </div>
  )
}
