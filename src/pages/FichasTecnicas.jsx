import { useState, useRef } from 'react'
import { useFichas, useProdutos, useFichaIngredientes, useTodosIngredientes } from '../hooks/useEstoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { analisarFichaTecnica, analisarPorcionados, prepararImagem } from '../services/geminiVision'
import { registrarProducao, registrarEvento } from '../services/estoque'
import { converterUnidade as converterParaUnidadeProduto } from '../lib/unidades'
import { criarCalculadoraDeCusto, formatBRL } from '../lib/custos'
import { expandirArquivosParaImagens } from '../lib/arquivos'
import { lerPorcionadosXlsx } from '../lib/porcionados'
import { Modal } from '../components/Modal'
import { Badge } from '../components/Badge'
import { SeletorProduto } from '../components/SeletorProduto'
import { X } from 'lucide-react'
import toast from 'react-hot-toast'

const CATEGORIAS = ['Pizza', 'Entradas', 'Principais', 'Saladas', 'Massa', 'Sobremesa', 'Bebida', 'Outros']
const UNIDADES_PRODUCAO = ['kg', 'g', 'l', 'ml', 'un']
const UNIDADES_MEDIDA = ['g', 'kg', 'ml', 'l']      // peso da porção (insumo gasto)
const UNIDADES_PORCIONADO = ['pct', 'un']            // unidade do produto gerado
const VAZIO_PRATO = { nome: '', categoria: 'Pizza', descricao: '', tipo_ficha: 'prato' }
const VAZIO_PRODUCAO = { nome: '', descricao: '', tipo_ficha: 'producao', produto_saida_id: '', unidade: 'kg', rendimento: '' }
const VAZIO_PORCIONADO = { nome: '', tipo_ficha: 'porcionado', medida: '', unidadeMedida: 'g', unidade: 'pct', insumoId: '' }

// Nome do produto gerado de um porcionado: "Abacaxi Porcionado 50G".
function nomePorcionado(base, medida, unidadeMedida) {
  const m = String(medida).replace('.', ',')
  return `${(base || '').trim()} Porcionado ${m}${(unidadeMedida || '').toUpperCase()}`
}

export function FichasTecnicas() {
  const fichas = useFichas()
  const produtos = useProdutos()
  const ingredientes = useTodosIngredientes()
  const custoUnit = criarCalculadoraDeCusto(produtos, fichas, ingredientes)
  const [aba, setAba] = useState('prato') // 'prato' | 'producao'
  const [modal, setModal] = useState(null)
  const [detalhe, setDetalhe] = useState(null)
  const [form, setForm] = useState(VAZIO_PRATO)
  const [busca, setBusca] = useState('')
  const [filtroCategoria, setFiltroCategoria] = useState('') // só na aba Pratos
  const [modalFoto, setModalFoto] = useState(false)
  const [fotoAnalise, setFotoAnalise] = useState(null)
  const [analisando, setAnalisando] = useState(false)
  const [resultadoFoto, setResultadoFoto] = useState(null)
  const [pickerIng, setPickerIng] = useState(null) // índice do insumo c/ seletor aberto
  const [pickerInsumoNovo, setPickerInsumoNovo] = useState(false) // seletor de insumo no form de novo porcionado
  const [porcionadosFoto, setPorcionadosFoto] = useState(null) // lista lida da foto (batch)
  const [pickerBatch, setPickerBatch] = useState(null) // { idx } — seletor de insumo de uma linha do batch
  const [criandoBatch, setCriandoBatch] = useState(false)
  const fileRefFoto = useRef()
  const cameraRefFoto = useRef()

  const apiKey = localStorage.getItem('gemini_api_key') || ''
  const ehProducao = aba === 'producao'
  const ehPorcionado = aba === 'porcionado'

  async function analisarFoto(e) {
    const original = e.target.files[0]
    e.target.value = ''
    if (!original) return

    // Porcionados: aceita planilha xlsx (lê direto as colunas PRODUTO + MEDIDA, sem IA).
    if (ehPorcionado && (/\.xlsx?$/i.test(original.name) || (original.type || '').includes('sheet'))) {
      const t = toast.loading('Lendo planilha...')
      try {
        const itens = await lerPorcionadosXlsx(original)
        const lista = itens.map(it => {
          const insumo = acharProdutoPorNome(it.nome)
          return {
            nome: it.nome,
            medida: it.medida ?? '',
            unidadeMedida: UNIDADES_MEDIDA.includes((it.unidade || '').toLowerCase()) ? it.unidade.toLowerCase() : 'g',
            unidade: 'pct',
            insumoId: insumo?.id ?? null,
          }
        }).filter(x => x.nome)
        toast.dismiss(t)
        if (lista.length === 0) { toast.error('Nenhum porcionado encontrado na planilha.'); return }
        setFotoAnalise(null)
        setPorcionadosFoto(lista)
        toast.success(`${lista.length} porcionado(s) lido(s). Revise antes de criar.`)
      } catch (err) {
        toast.dismiss(t)
        toast.error('Erro ao ler planilha: ' + (err?.message || 'verifique o arquivo'), { duration: 6000 })
      }
      return
    }

    let file = original
    if (original.type === 'application/pdf' || /\.pdf$/i.test(original.name)) {
      const t = toast.loading('Lendo arquivo...')
      try {
        const imgs = await expandirArquivosParaImagens([original], true)
        file = imgs[0]
      } catch {
        toast.error('Não foi possível ler o PDF.')
        return
      } finally {
        toast.dismiss(t)
      }
      if (!file) return
    }
    setFotoAnalise({ url: URL.createObjectURL(file), file })
    setResultadoFoto(null)
    setPorcionadosFoto(null)
  }

  // Acha o produto do estoque que melhor casa com um nome (exato, depois parcial).
  function acharProdutoPorNome(nome) {
    const b = (nome || '').trim().toLowerCase()
    if (!b) return null
    let prod = produtos.find(p => p.nome.toLowerCase() === b)
    if (!prod) prod = produtos.find(p => p.nome.toLowerCase().includes(b) || b.includes(p.nome.toLowerCase()))
    return prod || null
  }

  // Cria uma ficha de PORCIONADO: produto gerado "{base} Porcionado {medida}"
  // (categoria Porcionados, unidade pct/un, rendimento 1) + insumo = produto cru
  // de mesmo nome, quantidade = medida (1 produção = 1 pacote).
  async function criarPorcionado({ base, medida, unidadeMedida, unidadeGerado, insumoId }, orgId) {
    const baseLimpo = (base || '').trim()
    if (!baseLimpo) return null
    const nomeGerado = nomePorcionado(baseLimpo, medida, unidadeMedida)

    // Produto gerado (porcionado): cria ou reaproveita pelo nome.
    let prodGeradoId
    const existente = produtos.find(p => p.nome.trim().toLowerCase() === nomeGerado.toLowerCase())
    if (existente) {
      prodGeradoId = existente.id
      await supabase.from('produtos').update({ unidade: unidadeGerado, categoria: 'Porcionados' }).eq('id', prodGeradoId)
    } else {
      const { data: novo, error } = await supabase.from('produtos')
        .insert({ organizacao_id: orgId, nome: nomeGerado, categoria: 'Porcionados', unidade: unidadeGerado, quantidade: 0, estoque_minimo: 0 })
        .select().single()
      if (error) { toast.error(error.message); return null }
      prodGeradoId = novo.id
      await registrarEvento('produto_novo', { produtoId: prodGeradoId, nome: nomeGerado })
    }

    const { data: ficha, error: errFicha } = await supabase.from('fichas_tecnicas')
      .insert({ organizacao_id: orgId, nome: nomeGerado, categoria: 'Porcionados', descricao: '', tipo_ficha: 'porcionado', produto_saida_id: prodGeradoId, rendimento: 1 })
      .select().single()
    if (errFicha) { toast.error(errFicha.message); return null }

    // Insumo: produto cru escolhido, ou achado pelo nome, ou criado.
    let insumo = insumoId ? produtos.find(p => p.id === insumoId) : null
    if (!insumo) insumo = acharProdutoPorNome(baseLimpo)
    let insumoProdId, insumoUnidade
    if (insumo) { insumoProdId = insumo.id; insumoUnidade = insumo.unidade }
    else {
      const { data: novoIns } = await supabase.from('produtos')
        .insert({ organizacao_id: orgId, nome: baseLimpo, categoria: 'Outros', unidade: unidadeMedida, quantidade: 0, estoque_minimo: 0 })
        .select().single()
      insumoProdId = novoIns?.id
      insumoUnidade = unidadeMedida
      if (insumoProdId) await registrarEvento('produto_novo', { produtoId: insumoProdId, nome: baseLimpo })
    }
    if (insumoProdId) {
      const qtd = converterParaUnidadeProduto(medida, unidadeMedida, insumoUnidade)
      await supabase.from('ficha_ingredientes').insert({ ficha_id: ficha.id, produto_id: insumoProdId, quantidade: qtd })
    }

    await registrarEvento('ficha_nova', { fichaId: ficha.id, nome: nomeGerado })
    return ficha
  }

  async function processarFoto() {
    if (!fotoAnalise) return
    if (!apiKey) return toast.error('Configure a chave da API na aba 📷 Lançar com Foto primeiro')
    setAnalisando(true)
    try {
      const { base64, mimeType } = await prepararImagem(fotoAnalise.file)

      // Porcionados: lê a LISTA inteira (cria vários de uma vez).
      if (ehPorcionado) {
        const res = await analisarPorcionados(base64, mimeType, apiKey)
        const lista = (res.itens || []).map(it => {
          const base = (it.nome || '').trim()
          const insumo = acharProdutoPorNome(base)
          return {
            nome: base,
            medida: it.medida ?? '',
            unidadeMedida: UNIDADES_MEDIDA.includes((it.unidade || '').toLowerCase()) ? it.unidade.toLowerCase() : 'g',
            unidade: 'pct',
            insumoId: insumo?.id ?? null,
          }
        }).filter(x => x.nome)
        setPorcionadosFoto(lista)
        setAnalisando(false)
        return
      }

      const res = await analisarFichaTecnica(base64, mimeType, produtos, apiKey, ehProducao ? 'producao' : 'prato')
      // Enriquece cada insumo: vínculo sugerido (produtoId) + defaults editáveis.
      const ingredientes = (res.ingredientes || []).map(ing => {
        const prod = acharProdutoPorNome(ing.nomeCadastrado || ing.nome)
        return {
          nome: ing.nome || '',
          quantidade: ing.quantidade ?? '',
          unidade: ing.unidade || 'un',
          produtoId: prod?.id ?? null,
        }
      })
      setResultadoFoto({ ...res, ingredientes })
    } catch (e) {
      toast.error(e.message || 'Erro ao analisar imagem')
    } finally {
      setAnalisando(false)
    }
  }

  // Edição do resultado da IA antes de salvar
  function editarResultado(patch) { setResultadoFoto(r => ({ ...r, ...patch })) }
  function editarIngrediente(i, patch) {
    setResultadoFoto(r => ({ ...r, ingredientes: r.ingredientes.map((ing, idx) => idx === i ? { ...ing, ...patch } : ing) }))
  }
  function removerIngrediente(i) {
    setResultadoFoto(r => ({ ...r, ingredientes: r.ingredientes.filter((_, idx) => idx !== i) }))
  }
  function adicionarIngrediente() {
    setResultadoFoto(r => ({ ...r, ingredientes: [...(r.ingredientes || []), { nome: '', quantidade: '', unidade: 'un', produtoId: null }] }))
  }

  // --- Batch de porcionados (foto) ---
  function editarBatch(i, patch) {
    setPorcionadosFoto(prev => prev.map((x, idx) => idx === i ? { ...x, ...patch } : x))
  }
  function removerBatch(i) {
    setPorcionadosFoto(prev => prev.filter((_, idx) => idx !== i))
  }
  function fecharFoto() {
    setModalFoto(false); setFotoAnalise(null); setResultadoFoto(null)
    setPickerIng(null); setPorcionadosFoto(null); setPickerBatch(null)
  }
  async function criarBatch() {
    const validos = (porcionadosFoto || []).filter(x => x.nome.trim() && parseFloat(String(x.medida).replace(',', '.')) > 0)
    if (validos.length === 0) return toast.error('Preencha nome e medida de ao menos um item')
    setCriandoBatch(true)
    let ok = 0
    for (const x of validos) {
      const ficha = await criarPorcionado({
        base: x.nome, medida: parseFloat(String(x.medida).replace(',', '.')),
        unidadeMedida: x.unidadeMedida, unidadeGerado: x.unidade,
        insumoId: x.insumoId || null,
      }, session.organizacaoId)
      if (ficha) ok++
    }
    setCriandoBatch(false)
    if (ok > 0) toast.success(`${ok} porcionado(s) criado(s)!`)
    fecharFoto()
  }

  // Resolve o produto de um insumo da ficha: usa o vínculo escolhido (produtoId)
  // ou cria um produto novo a partir do nome editado. Retorna { produtoId, unidadeDestino }.
  async function resolverInsumo(ing, orgId) {
    let produtoId = ing.produtoId
    let unidadeDestino
    if (produtoId) {
      unidadeDestino = produtos.find(p => p.id === produtoId)?.unidade || ing.unidade || 'un'
    } else {
      const nome = (ing.nome || '').trim()
      if (!nome) return null
      const { data: novo } = await supabase
        .from('produtos')
        .insert({ organizacao_id: orgId, nome, categoria: 'Outros', unidade: ing.unidade || 'un', quantidade: 0, estoque_minimo: 0 })
        .select().single()
      produtoId = novo?.id
      unidadeDestino = ing.unidade || 'un'
      if (produtoId) await registrarEvento('produto_novo', { produtoId, nome })
    }
    return { produtoId, unidadeDestino }
  }

  async function salvarFichaFoto() {
    if (!resultadoFoto) return
    const nome = (resultadoFoto.nome || '').trim()
    if (!nome) return toast.error('Informe o nome do prato')
    const orgId = session.organizacaoId

    const { data: ficha, error } = await supabase
      .from('fichas_tecnicas')
      .insert({
        organizacao_id: orgId,
        nome,
        categoria: resultadoFoto.categoria || 'Pizza',
        descricao: resultadoFoto.descricao || '',
        tipo_ficha: 'prato',
      })
      .select()
      .single()
    if (error) return toast.error(error.message)

    for (const ing of resultadoFoto.ingredientes) {
      const r = await resolverInsumo(ing, orgId)
      if (!r?.produtoId) continue
      const qtd = converterParaUnidadeProduto(ing.quantidade, ing.unidade, r.unidadeDestino)
      await supabase.from('ficha_ingredientes').insert({ ficha_id: ficha.id, produto_id: r.produtoId, quantidade: qtd })
    }
    await registrarEvento('ficha_nova', { fichaId: ficha.id, nome })
    toast.success(`Ficha "${nome}" criada com ${resultadoFoto.ingredientes.length} ingrediente(s)!`)
    setModalFoto(false)
    setFotoAnalise(null)
    setResultadoFoto(null)
  }

  async function salvarFichaProducaoFoto() {
    if (!resultadoFoto) return
    const orgId = session.organizacaoId
    const nome = (resultadoFoto.nome || '').trim()
    if (!nome) return toast.error('Não foi possível identificar o nome do produto gerado')
    const unidade = UNIDADES_PRODUCAO.includes((resultadoFoto.unidade || '').toLowerCase())
      ? resultadoFoto.unidade.toLowerCase() : 'kg'
    const rendimento = parseFloat(resultadoFoto.rendimento) > 0 ? parseFloat(resultadoFoto.rendimento) : 1

    // Produto gerado: cria ou reaproveita pelo nome
    let prodGeradoId
    const existente = produtos.find(p => p.nome.trim().toLowerCase() === nome.toLowerCase())
    if (existente) {
      prodGeradoId = existente.id
      await supabase.from('produtos').update({ unidade }).eq('id', prodGeradoId)
    } else {
      const { data: novo, error: e1 } = await supabase
        .from('produtos')
        .insert({ organizacao_id: orgId, nome, categoria: 'Produções Internas', unidade, quantidade: 0, estoque_minimo: 0 })
        .select().single()
      if (e1) return toast.error(e1.message)
      prodGeradoId = novo.id
      await registrarEvento('produto_novo', { produtoId: prodGeradoId, nome })
    }

    const { data: ficha, error } = await supabase
      .from('fichas_tecnicas')
      .insert({
        organizacao_id: orgId, nome, categoria: 'Produção', descricao: resultadoFoto.descricao || '',
        tipo_ficha: 'producao', produto_saida_id: prodGeradoId, rendimento,
      })
      .select().single()
    if (error) return toast.error(error.message)

    for (const ing of resultadoFoto.ingredientes || []) {
      const r = await resolverInsumo(ing, orgId)
      if (!r?.produtoId) continue
      const qtd = converterParaUnidadeProduto(ing.quantidade, ing.unidade, r.unidadeDestino)
      await supabase.from('ficha_ingredientes').insert({ ficha_id: ficha.id, produto_id: r.produtoId, quantidade: qtd })
    }

    await registrarEvento('ficha_nova', { fichaId: ficha.id, nome })
    toast.success(`Ficha de produção "${nome}" criada com ${(resultadoFoto.ingredientes || []).length} insumo(s)!`)
    setModalFoto(false)
    setFotoAnalise(null)
    setResultadoFoto(null)
  }

  const filtradas = fichas.filter(f =>
    (f.tipo_ficha || 'prato') === aba &&
    f.nome.toLowerCase().includes(busca.toLowerCase()) &&
    (aba !== 'prato' || !filtroCategoria || f.categoria === filtroCategoria)
  )

  function trocarAba(novaAba) {
    setAba(novaAba)
    setDetalhe(null)
    setFiltroCategoria('')
  }

  function abrirNovo() {
    setForm(ehPorcionado ? VAZIO_PORCIONADO : ehProducao ? VAZIO_PRODUCAO : VAZIO_PRATO)
    setModal('novo')
  }
  function abrirEditar(f) {
    const unidade = produtos.find(p => p.id === f.produto_saida_id)?.unidade || 'kg'
    setForm({ ...f, produto_saida_id: f.produto_saida_id ?? '', rendimento: f.rendimento ?? '', unidade })
    setModal(f)
  }
  function fechar() { setModal(null) }

  async function salvar() {
    const tipo = form.tipo_ficha || 'prato'

    // Porcionado NOVO: fluxo próprio (nome base + medida + insumo automático).
    if (tipo === 'porcionado' && modal === 'novo') {
      const base = (form.nome || '').trim()
      if (!base) return toast.error('Nome obrigatório')
      const medida = parseFloat(String(form.medida).replace(',', '.'))
      if (!medida || medida <= 0) return toast.error('Informe a medida da porção (maior que zero)')
      const ficha = await criarPorcionado({
        base, medida, unidadeMedida: form.unidadeMedida, unidadeGerado: form.unidade,
        insumoId: form.insumoId ? parseInt(form.insumoId) : null,
      }, session.organizacaoId)
      if (!ficha) return
      toast.success('Porcionado criado!')
      setDetalhe(ficha)
      return fechar()
    }

    if (!form.nome.trim()) return toast.error('Nome obrigatório')
    let data
    if (tipo === 'producao' || tipo === 'porcionado') {
      const ehPorc = tipo === 'porcionado'
      if (!ehPorc && (!form.rendimento || parseFloat(form.rendimento) <= 0)) return toast.error('Informe o rendimento (maior que zero)')
      const nome = form.nome.trim()
      const unidade = form.unidade || (ehPorc ? 'pct' : 'kg')
      const categoriaProd = ehPorc ? 'Porcionados' : 'Produções Internas'
      const orgId = session.organizacaoId

      // O produto gerado é o próprio nome da ficha — cria no estoque (ou
      // reaproveita se já existir um produto com o mesmo nome). Na edição,
      // sincroniza nome/unidade do produto vinculado.
      let produtoSaidaId = form.produto_saida_id ? parseInt(form.produto_saida_id) : null
      if (produtoSaidaId) {
        await supabase.from('produtos').update({ nome, unidade, categoria: categoriaProd }).eq('id', produtoSaidaId)
      } else {
        const existente = produtos.find(p => p.nome.trim().toLowerCase() === nome.toLowerCase())
        if (existente) {
          produtoSaidaId = existente.id
          await supabase.from('produtos').update({ unidade, categoria: categoriaProd }).eq('id', produtoSaidaId)
        } else {
          const { data: novoProd, error: errProd } = await supabase
            .from('produtos')
            .insert({ organizacao_id: orgId, nome, categoria: categoriaProd, unidade, quantidade: 0, estoque_minimo: 0 })
            .select()
            .single()
          if (errProd) return toast.error(errProd.message)
          produtoSaidaId = novoProd.id
          await registrarEvento('produto_novo', { produtoId: produtoSaidaId, nome })
        }
      }

      data = {
        nome,
        categoria: ehPorc ? 'Porcionados' : 'Produção',
        descricao: form.descricao || '',
        tipo_ficha: tipo,
        produto_saida_id: produtoSaidaId,
        rendimento: ehPorc ? 1 : parseFloat(form.rendimento),
      }
    } else {
      data = {
        nome: form.nome.trim(),
        categoria: form.categoria,
        descricao: form.descricao || '',
        tipo_ficha: 'prato',
      }
    }

    if (modal === 'novo') {
      const { data: ficha, error } = await supabase
        .from('fichas_tecnicas')
        .insert({ ...data, organizacao_id: session.organizacaoId })
        .select()
        .single()
      if (error) return toast.error(error.message)
      await registrarEvento('ficha_nova', { fichaId: ficha.id, nome: data.nome })
      toast.success('Ficha criada!')
      setDetalhe({ ...data, id: ficha.id })
    } else {
      const { error } = await supabase.from('fichas_tecnicas').update(data).eq('id', modal.id)
      if (error) return toast.error(error.message)
      await registrarEvento('ficha_editada', { fichaId: modal.id, nome: data.nome })
      toast.success('Ficha atualizada!')
      setDetalhe(d => (d?.id === modal.id ? { ...d, ...data } : d))
    }
    fechar()
  }

  async function excluir(f) {
    const ehProd = f.tipo_ficha === 'producao' || f.tipo_ficha === 'porcionado'
    if (!confirm('Excluir esta ficha?')) return
    // Remove as linhas da receita desta ficha (não apaga os produtos/insumos).
    await supabase.from('ficha_ingredientes').delete().eq('ficha_id', f.id)
    await supabase.from('fichas_tecnicas').delete().eq('id', f.id)

    // Produção: remove o produto gerado SOMENTE se ele não for usado como
    // insumo em nenhuma outra ficha (assim insumos em uso nunca somem).
    if (ehProd && f.produto_saida_id) {
      const { data: usos } = await supabase
        .from('ficha_ingredientes').select('id').eq('produto_id', f.produto_saida_id).limit(1)
      if (!usos || usos.length === 0) {
        await supabase.from('produtos').delete().eq('id', f.produto_saida_id)
      }
    }
    await registrarEvento('ficha_excluida', { nome: f.nome })
    toast.success('Ficha excluída')
    fechar()
    if (detalhe?.id === f.id) setDetalhe(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">Fichas Técnicas</h1>
        <div className="flex gap-2">
          <button onClick={() => setModalFoto(true)} className="btn-secondary text-sm">📷 Importar por Foto</button>
          <button onClick={abrirNovo} className="btn-primary text-sm">+ Nova Ficha</button>
        </div>
      </div>

      {/* Alternância Pratos | Produção | Porcionados */}
      <div className="flex bg-gray-100 rounded-xl p-1 gap-1 max-w-md">
        <button
          onClick={() => trocarAba('prato')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${aba === 'prato' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
        >
          🍕 Pratos
        </button>
        <button
          onClick={() => trocarAba('producao')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${aba === 'producao' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
        >
          ⚙️ Produção
        </button>
        <button
          onClick={() => trocarAba('porcionado')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${aba === 'porcionado' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
        >
          📦 Porcionados
        </button>
      </div>

      <p className="text-xs text-gray-500">
        {ehPorcionado
          ? 'Porcionar: divide um produto a granel em porções. Cada produção = 1 pacote; consome a medida em insumo do mesmo nome.'
          : ehProducao
            ? 'Receitas de fabricação: ao produzir, consomem insumos e geram um produto para o estoque (ex: massa, molho).'
            : 'Receitas de pratos vendidos: ao registrar a venda, consomem os ingredientes do estoque.'}
      </p>

      <div className="flex gap-2">
        <input
          placeholder="Buscar ficha..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          className="input flex-1 min-w-0"
        />
        {aba === 'prato' && (
          <select value={filtroCategoria} onChange={e => setFiltroCategoria(e.target.value)} className="input w-auto">
            <option value="">Todas categorias</option>
            {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
          </select>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtradas.map(f => {
          const prodGerado = produtos.find(p => p.id === f.produto_saida_id)
          return (
            <div
              key={f.id}
              onClick={() => setDetalhe(f)}
              className={`bg-white border rounded-xl p-4 cursor-pointer hover:shadow-md transition-shadow ${detalhe?.id === f.id ? 'border-red-400 ring-1 ring-red-300' : 'border-gray-200'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-800">{f.nome}</p>
                  {f.tipo_ficha === 'producao'
                    ? <p className="text-xs text-gray-500 mt-1">Rende {f.rendimento || '—'} {prodGerado?.unidade || ''}/lote</p>
                    : f.tipo_ficha === 'porcionado'
                      ? <p className="text-xs text-gray-500 mt-1">1 {prodGerado?.unidade || 'pct'} por produção</p>
                      : (f.descricao && <p className="text-xs text-gray-400 mt-1 line-clamp-2">{f.descricao}</p>)
                  }
                </div>
                <Badge color={f.tipo_ficha === 'producao' ? 'blue' : f.tipo_ficha === 'porcionado' ? 'green' : 'orange'}>
                  {f.tipo_ficha === 'producao' ? 'Produção' : f.tipo_ficha === 'porcionado' ? 'Porcionado' : f.categoria}
                </Badge>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={e => { e.stopPropagation(); abrirEditar(f) }} className="text-xs text-blue-500 hover:text-blue-700">Editar</button>
                <button onClick={e => { e.stopPropagation(); excluir(f) }} className="text-xs text-red-500 hover:text-red-700">Excluir</button>
              </div>
            </div>
          )
        })}
        {filtradas.length === 0 && (
          <p className="text-gray-400 text-sm col-span-full text-center py-8">Nenhuma ficha encontrada.</p>
        )}
      </div>

      {detalhe && <DetalheIngredientes ficha={detalhe} custoUnit={custoUnit} fichas={fichas} todosIngredientes={ingredientes} />}

      {modal && form.tipo_ficha === 'porcionado' && modal === 'novo' ? (
        <Modal title="Novo Porcionado" onClose={fechar}>
          <div className="space-y-3">
            <div>
              <label className="label">Nome do produto *</label>
              <input className="input" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder="Ex: Abacaxi" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Medida da porção *</label>
                <div className="flex gap-1">
                  <input type="number" min="0.001" step="0.001" className="input" value={form.medida} onChange={e => setForm(f => ({ ...f, medida: e.target.value }))} placeholder="Ex: 50" />
                  <select className="input w-20" value={form.unidadeMedida} onChange={e => setForm(f => ({ ...f, unidadeMedida: e.target.value }))}>
                    {UNIDADES_MEDIDA.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Unidade do pacote *</label>
                <select className="input" value={form.unidade} onChange={e => setForm(f => ({ ...f, unidade: e.target.value }))}>
                  {UNIDADES_PORCIONADO.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="label">Insumo (produto cru consumido)</label>
              <button onClick={() => setPickerInsumoNovo(true)} className={`input text-left ${form.insumoId ? 'text-gray-800' : 'text-gray-400'}`}>
                {form.insumoId
                  ? produtos.find(p => p.id === parseInt(form.insumoId))?.nome
                  : (acharProdutoPorNome(form.nome)?.nome || `Criar "${form.nome.trim() || '...'}" automaticamente`)}
              </button>
            </div>
            {form.nome.trim() && form.medida && (
              <p className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2">
                Será criado: <strong>{nomePorcionado(form.nome, form.medida, form.unidadeMedida)}</strong> ({form.unidade}).
                Cada produção consome {form.medida} {form.unidadeMedida} de insumo.
              </p>
            )}
            <button onClick={salvar} className="btn-primary w-full">Criar Porcionado</button>
          </div>

          {pickerInsumoNovo && (
            <SeletorProduto
              titulo="Insumo do porcionado"
              produtos={produtos}
              onEscolher={p => { setForm(f => ({ ...f, insumoId: String(p.id) })); setPickerInsumoNovo(false) }}
              onClose={() => setPickerInsumoNovo(false)}
              opcaoExtra={{ label: '+ Criar pelo nome digitado', onEscolher: () => { setForm(f => ({ ...f, insumoId: '' })); setPickerInsumoNovo(false) } }}
            />
          )}
        </Modal>
      ) : modal && (
        <Modal title={modal === 'novo' ? (form.tipo_ficha === 'producao' ? 'Nova Ficha de Produção' : 'Nova Ficha de Prato') : 'Editar Ficha'} onClose={fechar}>
          <div className="space-y-3">
            <div>
              <label className="label">{(form.tipo_ficha === 'producao' || form.tipo_ficha === 'porcionado') ? 'Nome do produto gerado *' : 'Nome *'}</label>
              <input className="input" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder={form.tipo_ficha === 'producao' ? 'Ex: Massa de Pizza' : 'Ex: Pizza Margherita'} />
            </div>

            {form.tipo_ficha === 'producao' ? (
              <>
                <div>
                  <label className="label">Unidade do produto gerado *</label>
                  <select className="input" value={form.unidade} onChange={e => setForm(f => ({ ...f, unidade: e.target.value }))}>
                    {UNIDADES_PRODUCAO.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Rendimento por lote *</label>
                  <input type="number" min="0.001" step="0.001" className="input" value={form.rendimento} onChange={e => setForm(f => ({ ...f, rendimento: e.target.value }))} placeholder={`Ex: 5 (${form.unidade || 'kg'} por produção)`} />
                </div>
              </>
            ) : form.tipo_ficha === 'porcionado' ? (
              <div>
                <label className="label">Unidade do pacote *</label>
                <select className="input" value={form.unidade} onChange={e => setForm(f => ({ ...f, unidade: e.target.value }))}>
                  {UNIDADES_PORCIONADO.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">A medida/insumo são editados na lista de insumos abaixo da ficha.</p>
              </div>
            ) : (
              <div>
                <label className="label">Categoria</label>
                <select className="input" value={form.categoria} onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))}>
                  {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}

            {form.tipo_ficha !== 'porcionado' && (
              <div>
                <label className="label">Descrição</label>
                <textarea className="input resize-none" rows={3} value={form.descricao} onChange={e => setForm(f => ({ ...f, descricao: e.target.value }))} placeholder="Descrição opcional..." />
              </div>
            )}
            <button onClick={salvar} className="btn-primary w-full">Salvar</button>
          </div>
        </Modal>
      )}

      {modalFoto && (
        <Modal title={ehPorcionado ? 'Importar Porcionados por Foto' : 'Importar Ficha por Foto'} onClose={fecharFoto}>
          <div className="space-y-4">
            <div className="border-2 border-dashed border-gray-300 rounded-xl p-4 text-center space-y-3">
              {fotoAnalise ? (
                <img src={fotoAnalise.url} alt="" className="max-h-48 mx-auto rounded-lg object-contain" />
              ) : (
                <p className="text-gray-400 text-sm">{ehPorcionado ? 'Foto OU planilha (.xlsx) da lista de porcionados (PRODUTO + MEDIDA)' : 'Foto da ficha técnica, cardápio ou receita'}</p>
              )}
              <div className="flex gap-2 justify-center flex-wrap">
                <button onClick={() => fileRefFoto.current.click()} className="btn-secondary text-sm">📁 Arquivo</button>
                <button onClick={() => cameraRefFoto.current.click()} className="btn-secondary text-sm">📷 Câmera</button>
              </div>
              <input ref={fileRefFoto} type="file" accept={ehPorcionado ? 'image/*,application/pdf,.xlsx,.xls' : 'image/*,application/pdf'} className="hidden" onChange={analisarFoto} />
              <input ref={cameraRefFoto} type="file" accept="image/*" capture="environment" className="hidden" onChange={analisarFoto} />
            </div>

            {fotoAnalise && !resultadoFoto && !porcionadosFoto && (
              <button onClick={processarFoto} disabled={analisando} className="btn-primary w-full disabled:opacity-50">
                {analisando ? 'Analisando...' : '🔍 Analisar com IA'}
              </button>
            )}

            {/* Batch de porcionados */}
            {ehPorcionado && porcionadosFoto && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500">{porcionadosFoto.length} porcionado(s) lido(s). Revise antes de criar.</p>
                  <button onClick={() => setPorcionadosFoto(prev => [...prev, { nome: '', medida: '', unidadeMedida: 'g', unidade: 'pct', insumoId: null }])} className="text-xs text-red-700 underline">+ adicionar</button>
                </div>
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {porcionadosFoto.map((x, i) => {
                    const insumo = x.insumoId ? produtos.find(p => p.id === x.insumoId) : null
                    return (
                      <div key={i} className="border border-gray-200 rounded-lg p-2 space-y-2">
                        <div className="flex items-center gap-2">
                          <input className="input text-sm flex-1" value={x.nome} onChange={e => editarBatch(i, { nome: e.target.value })} placeholder="Nome" />
                          <button onClick={() => removerBatch(i)} className="text-gray-300 hover:text-red-500 shrink-0"><X className="w-4 h-4" /></button>
                        </div>
                        <div className="flex items-center gap-2">
                          <input type="number" min="0" step="0.001" className="input text-sm w-20" value={x.medida} onChange={e => editarBatch(i, { medida: e.target.value })} placeholder="Medida" />
                          <select className="input text-sm w-16" value={x.unidadeMedida} onChange={e => editarBatch(i, { unidadeMedida: e.target.value })}>
                            {UNIDADES_MEDIDA.map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                          <select className="input text-sm w-16" value={x.unidade} onChange={e => editarBatch(i, { unidade: e.target.value })}>
                            {UNIDADES_PORCIONADO.map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                          <button onClick={() => setPickerBatch({ idx: i })} className={`text-xs underline ml-auto truncate ${insumo ? 'text-green-700' : 'text-gray-500'}`}>
                            {insumo ? `✓ ${insumo.nome}` : 'criar insumo'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {porcionadosFoto.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-2">Nenhum item. Toque em "+ adicionar".</p>
                  )}
                </div>
                <button onClick={criarBatch} disabled={criandoBatch} className="btn-primary w-full disabled:opacity-50">
                  {criandoBatch ? 'Criando...' : `Criar ${porcionadosFoto.filter(x => x.nome.trim() && parseFloat(String(x.medida).replace(',', '.')) > 0).length} porcionado(s)`}
                </button>
              </div>
            )}

            {!ehPorcionado && resultadoFoto && (
              <div className="space-y-3">
                <p className="text-xs text-gray-500">Revise e ajuste o que a IA leu antes de criar a ficha.</p>

                {/* Nome do prato / produto gerado */}
                <div>
                  <label className="label">{ehProducao ? 'Nome do produto gerado' : 'Nome do prato'}</label>
                  <input
                    className="input"
                    value={resultadoFoto.nome || ''}
                    onChange={e => editarResultado({ nome: e.target.value })}
                    placeholder={ehProducao ? 'Ex: Massa de Pizza' : 'Ex: Pizza Margherita'}
                  />
                </div>

                {/* Produção: unidade + rendimento */}
                {ehProducao && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="label">Unidade</label>
                      <select
                        className="input"
                        value={UNIDADES_PRODUCAO.includes((resultadoFoto.unidade || '').toLowerCase()) ? resultadoFoto.unidade.toLowerCase() : 'kg'}
                        onChange={e => editarResultado({ unidade: e.target.value })}
                      >
                        {UNIDADES_PRODUCAO.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label">Rende por lote</label>
                      <input
                        type="number" min="0.001" step="0.001" className="input"
                        value={resultadoFoto.rendimento ?? ''}
                        onChange={e => editarResultado({ rendimento: e.target.value })}
                        placeholder="Ex: 5"
                      />
                    </div>
                  </div>
                )}

                {resultadoFoto.observacao && <p className="text-xs text-yellow-700">⚠️ {resultadoFoto.observacao}</p>}

                {/* Insumos editáveis */}
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-gray-500 uppercase">{ehProducao ? 'Insumos' : 'Ingredientes'}</p>
                  <button onClick={adicionarIngrediente} className="text-xs text-red-700 underline">+ adicionar</button>
                </div>
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {resultadoFoto.ingredientes.map((ing, i) => {
                    const prod = ing.produtoId ? produtos.find(p => p.id === ing.produtoId) : null
                    return (
                      <div key={i} className="border border-gray-200 rounded-lg p-2 space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            className="input text-sm flex-1"
                            value={ing.nome}
                            onChange={e => editarIngrediente(i, { nome: e.target.value })}
                            placeholder="Nome do insumo"
                          />
                          <button onClick={() => removerIngrediente(i)} className="text-gray-300 hover:text-red-500 shrink-0" aria-label="Remover">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number" min="0" step="0.001" inputMode="decimal"
                            className="input text-sm w-24"
                            value={ing.quantidade}
                            onChange={e => editarIngrediente(i, { quantidade: e.target.value })}
                            placeholder="Qtd"
                          />
                          <input
                            className="input text-sm w-20"
                            value={ing.unidade}
                            onChange={e => editarIngrediente(i, { unidade: e.target.value })}
                            placeholder="un"
                          />
                          <button
                            onClick={() => setPickerIng(i)}
                            className={`text-xs underline ml-auto truncate ${prod ? 'text-green-700' : 'text-gray-500'}`}
                          >
                            {prod ? `✓ ${prod.nome}` : 'criar novo'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {resultadoFoto.ingredientes.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-2">Nenhum insumo. Toque em "+ adicionar".</p>
                  )}
                </div>

                <button onClick={ehProducao ? salvarFichaProducaoFoto : salvarFichaFoto} className="btn-primary w-full">
                  ✅ Criar Ficha com {resultadoFoto.ingredientes.length} {ehProducao ? 'insumo(s)' : 'ingrediente(s)'}
                </button>
              </div>
            )}

            {/* Seletor de produto para vincular um insumo da IA */}
            {pickerIng !== null && resultadoFoto && (
              <SeletorProduto
                titulo="Vincular insumo a produto"
                produtos={produtos}
                onEscolher={p => { editarIngrediente(pickerIng, { produtoId: p.id }); setPickerIng(null) }}
                onClose={() => setPickerIng(null)}
                opcaoExtra={{
                  label: '+ Criar produto novo (usar o nome digitado)',
                  onEscolher: () => { editarIngrediente(pickerIng, { produtoId: null }); setPickerIng(null) },
                }}
              />
            )}

            {/* Seletor de insumo de uma linha do batch de porcionados */}
            {pickerBatch && (
              <SeletorProduto
                titulo="Insumo do porcionado"
                produtos={produtos}
                onEscolher={p => { editarBatch(pickerBatch.idx, { insumoId: p.id }); setPickerBatch(null) }}
                onClose={() => setPickerBatch(null)}
                opcaoExtra={{ label: '+ Criar pelo nome digitado', onEscolher: () => { editarBatch(pickerBatch.idx, { insumoId: null }); setPickerBatch(null) } }}
              />
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

function DetalheIngredientes({ ficha, custoUnit, fichas = [], todosIngredientes = [] }) {
  const produtos = useProdutos()
  const ingredientes = useFichaIngredientes(ficha.id)
  const [form, setForm] = useState({ produtoId: '', quantidade: '', altId: '', quantidadeAlt: '' })
  const [lotes, setLotes] = useState('')
  const [produzindo, setProduzindo] = useState(false)
  const [pickerAberto, setPickerAberto] = useState(false)
  const [pickerAlt, setPickerAlt] = useState(false)
  const [reservaAberta, setReservaAberta] = useState(false)
  const [sugestaoRaw, setSugestaoRaw] = useState(null) // { altId, rawPorPacote }
  const [aviso, setAviso] = useState(null) // lista de insumos que vão cair no cru
  const [editId, setEditId] = useState(null) // id do insumo em edição inline
  const [editForm, setEditForm] = useState({ produtoId: '', quantidade: '', unidade: '', altId: '', quantidadeAlt: '' })
  const [editPicker, setEditPicker] = useState(false) // seletor de porcionado na edição inline
  const produtoSel = produtos.find(p => p.id === parseInt(form.produtoId))
  const altSel = produtos.find(p => p.id === parseInt(form.altId))

  const ehPorcionado = ficha.tipo_ficha === 'porcionado'
  const ehProducao = ficha.tipo_ficha === 'producao' || ehPorcionado
  const mostrarReserva = ficha.tipo_ficha === 'producao' || ficha.tipo_ficha === 'prato' // o "OU" (Produção e Prato)
  const prodGerado = produtos.find(p => p.id === ficha.produto_saida_id)
  // Produtos que são porcionados (para anexar como insumo principal "OU").
  const porcionados = produtos.filter(p =>
    p.categoria === 'Porcionados' || fichas.some(f => f.tipo_ficha === 'porcionado' && f.produto_saida_id === p.id)
  )

  // Custo total dos insumos desta ficha (resolve produtos de produção também)
  const custoTotal = ingredientes.reduce((s, ing) => s + (ing.quantidade || 0) * (custoUnit ? custoUnit(ing.produto_id) : 0), 0)
  const custoPorUnidade = ehProducao && ficha.rendimento > 0 ? custoTotal / ficha.rendimento : 0

  // Ao escolher o insumo principal: se for um PORCIONADO, sugere o cru como
  // reserva (achando a ficha do porcionado e o seu insumo cru).
  function escolherPrincipal(p) {
    setForm(f => ({ ...f, produtoId: String(p.id) }))
    setPickerAberto(false)
    const fp = fichas.find(x => x.tipo_ficha === 'porcionado' && x.produto_saida_id === p.id)
    const ingRaw = fp ? todosIngredientes.find(i => i.ficha_id === fp.id) : null
    if (ingRaw) {
      setSugestaoRaw({ altId: ingRaw.produto_id, rawPorPacote: ingRaw.quantidade || 0 })
      setReservaAberta(true)
      setForm(f => ({ ...f, altId: String(ingRaw.produto_id) }))
    } else {
      setSugestaoRaw(null)
    }
  }

  function mudarQuantidade(v) {
    setForm(f => {
      const next = { ...f, quantidade: v }
      if (sugestaoRaw && String(f.altId) === String(sugestaoRaw.altId)) {
        const q = parseFloat(String(v).replace(',', '.')) || 0
        next.quantidadeAlt = q ? String(Math.round(q * sugestaoRaw.rawPorPacote * 1000) / 1000) : ''
      }
      return next
    })
  }

  async function adicionar() {
    if (!form.produtoId || !form.quantidade) return toast.error('Preencha produto e quantidade')
    const existe = ingredientes.find(i => i.produto_id === parseInt(form.produtoId))
    if (existe) return toast.error('Ingrediente já adicionado')
    const insert = {
      ficha_id: ficha.id,
      produto_id: parseInt(form.produtoId),
      quantidade: parseFloat(form.quantidade),
    }
    if (mostrarReserva && form.altId && form.quantidadeAlt) {
      insert.produto_alt_id = parseInt(form.altId)
      insert.quantidade_alt = parseFloat(String(form.quantidadeAlt).replace(',', '.'))
    }
    const { error } = await supabase.from('ficha_ingredientes').insert(insert)
    if (error) return toast.error(error.message)
    setForm({ produtoId: '', quantidade: '', altId: '', quantidadeAlt: '' })
    setSugestaoRaw(null); setReservaAberta(false)
    toast.success('Insumo adicionado!')
  }

  async function remover(id) {
    await supabase.from('ficha_ingredientes').delete().eq('id', id)
  }

  // --- Edição inline de um insumo ---
  // Edita quantidade/unidade sem deletar; e permite ANEXAR um porcionado a um
  // insumo já existente (o porcionado vira o principal, consumido primeiro, e o
  // produto que estava lá vira a reserva "OU" — o cru). A unidade exibida é
  // sempre a do produto; o seletor converte de outra unidade de peso/volume.
  function iniciarEdicao(ing) {
    const prod = produtos.find(p => p.id === ing.produto_id)
    setEditForm({
      produtoId: String(ing.produto_id),
      quantidade: String(ing.quantidade ?? ''),
      unidade: prod?.unidade || 'un',
      altId: ing.produto_alt_id ? String(ing.produto_alt_id) : '',
      quantidadeAlt: ing.quantidade_alt != null ? String(ing.quantidade_alt) : '',
    })
    setEditId(ing.id)
  }

  function cancelarEdicao() { setEditId(null); setEditPicker(false) }

  // Troca a unidade de entrada e reconverte o número para manter a equivalência.
  function mudarUnidadeEdicao(nova) {
    setEditForm(f => {
      const atual = parseFloat(String(f.quantidade).replace(',', '.'))
      if (isNaN(atual)) return { ...f, unidade: nova }
      return { ...f, unidade: nova, quantidade: String(converterParaUnidadeProduto(atual, f.unidade, nova)) }
    })
  }

  // Anexa um porcionado ao insumo em edição: o porcionado vira o principal e o
  // produto atual (cru) vira a reserva. Sugere os pacotes pela medida do porcionado.
  function usarPorcionadoNaEdicao(p) {
    setEditPicker(false)
    setEditForm(f => {
      const cruId = f.produtoId
      const cruUn = produtos.find(x => x.id === parseInt(cruId))?.unidade || 'un'
      const cruQty = converterParaUnidadeProduto(parseFloat(String(f.quantidade).replace(',', '.')) || 0, f.unidade, cruUn)
      const fp = fichas.find(x => x.tipo_ficha === 'porcionado' && x.produto_saida_id === p.id)
      const ingRaw = fp ? todosIngredientes.find(i => i.ficha_id === fp.id) : null
      const rawPorPacote = ingRaw?.quantidade || 0
      const packs = rawPorPacote > 0 ? Math.round((cruQty / rawPorPacote) * 1000) / 1000 : ''
      return {
        produtoId: String(p.id),
        quantidade: packs === '' ? '' : String(packs),
        unidade: p.unidade || 'pct',
        altId: cruId,
        quantidadeAlt: String(cruQty),
      }
    })
  }

  // Desfaz o porcionado: o cru de reserva volta a ser o insumo principal.
  function removerPorcionadoNaEdicao() {
    setEditForm(f => {
      if (!f.altId) return f
      const cruUn = produtos.find(x => x.id === parseInt(f.altId))?.unidade || 'un'
      return { produtoId: f.altId, quantidade: f.quantidadeAlt || '', unidade: cruUn, altId: '', quantidadeAlt: '' }
    })
  }

  async function salvarEdicao(ing) {
    const principal = produtos.find(p => p.id === parseInt(editForm.produtoId))
    const principalUn = principal?.unidade || 'un'
    const valor = parseFloat(String(editForm.quantidade).replace(',', '.'))
    if (isNaN(valor) || valor < 0) return toast.error('Informe uma quantidade válida')
    const novoProdId = parseInt(editForm.produtoId)
    if (ingredientes.find(i => i.id !== ing.id && i.produto_id === novoProdId)) {
      return toast.error('Já existe um insumo com esse produto principal nesta ficha')
    }
    const update = {
      produto_id: novoProdId,
      quantidade: converterParaUnidadeProduto(valor, editForm.unidade, principalUn),
      produto_alt_id: null,
      quantidade_alt: null,
    }
    if (mostrarReserva && editForm.altId) {
      const va = parseFloat(String(editForm.quantidadeAlt).replace(',', '.'))
      update.produto_alt_id = parseInt(editForm.altId)
      update.quantidade_alt = (!isNaN(va) && va >= 0) ? va : 0
    }
    const { error } = await supabase.from('ficha_ingredientes').update(update).eq('id', ing.id)
    if (error) return toast.error(error.message)
    setEditId(null); setEditPicker(false)
    toast.success('Insumo atualizado!')
  }

  // Quais insumos com reserva vão cair no cru (porcionado insuficiente)?
  function planejarFallback() {
    const n = parseFloat(lotes) || 0
    if (!n) return []
    return ingredientes.filter(i => i.produto_alt_id).map(i => {
      const prim = produtos.find(p => p.id === i.produto_id)
      const precisa = (i.quantidade || 0) * n
      if ((prim?.quantidade || 0) < precisa) {
        const alt = produtos.find(p => p.id === i.produto_alt_id)
        return {
          primNome: prim?.nome || 'Porcionado', tem: prim?.quantidade || 0, primUn: prim?.unidade || '',
          precisa, altNome: alt?.nome || 'Cru', altQtd: (i.quantidade_alt || 0) * n, altUn: alt?.unidade || '',
        }
      }
      return null
    }).filter(Boolean)
  }

  async function produzir() {
    if (ingredientes.length === 0) return toast.error('Adicione os insumos antes de produzir')
    const fallback = planejarFallback()
    if (fallback.length > 0) { setAviso(fallback); return }
    await executarProducao()
  }

  async function executarProducao() {
    setAviso(null)
    setProduzindo(true)
    try {
      const gerado = await registrarProducao(ficha.id, lotes)
      toast.success(`Produzido! +${gerado} ${prodGerado?.unidade || ''} de ${prodGerado?.nome || 'produto'}`)
      setLotes('')
    } catch (e) {
      toast.error(e.message || 'Erro ao produzir', { duration: 6000 })
    } finally {
      setProduzindo(false)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <h2 className="font-semibold text-gray-800 mb-1">
        {ehProducao ? 'Insumos' : 'Ingredientes'} — <span className="text-red-600">{ficha.nome}</span>
      </h2>
      {!ehProducao && (
        <p className="text-sm text-gray-600 mb-4">Custo da ficha: <strong className="text-gray-800">{formatBRL(custoTotal)}</strong></p>
      )}
      {ehProducao && <div className="mb-4" />}

      {ehProducao && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
          <p className="text-sm text-gray-700">
            Gera <strong>{prodGerado?.nome || '—'}</strong>
            {ehPorcionado
              ? <> — <strong>1 {prodGerado?.unidade || 'pct'}</strong> por produção</>
              : ficha.rendimento ? <> — rende <strong>{ficha.rendimento} {prodGerado?.unidade || ''}</strong> por lote</> : ' — defina o rendimento'}
          </p>
          <p className="text-sm text-gray-700">
            Custo por {ehPorcionado ? (prodGerado?.unidade || 'pct') : 'lote'}: <strong className="text-gray-800">{formatBRL(ehPorcionado ? custoPorUnidade : custoTotal)}</strong>
            {!ehPorcionado && ficha.rendimento > 0 && <> · por {prodGerado?.unidade || 'un'}: <strong className="text-gray-800">{formatBRL(custoPorUnidade)}</strong></>}
          </p>
          <div className="flex gap-2 items-end">
            <div>
              <label className="label">{ehPorcionado ? 'Quantos pacotes produzir' : 'Lotes a produzir'}</label>
              <input type="number" min="1" step="1" className="input w-28" placeholder="Ex: 1" value={lotes} onChange={e => setLotes(e.target.value)} />
            </div>
            <button onClick={produzir} disabled={produzindo} className="btn-primary disabled:opacity-50">
              {produzindo ? 'Produzindo...' : '⚙️ Produzir'}
            </button>
          </div>
          <p className="text-xs text-gray-500">Consome os insumos abaixo e adiciona {prodGerado?.nome || 'o produto'} ao estoque.</p>
        </div>
      )}

      <div className="space-y-2 mb-4">
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setPickerAberto(true)}
            className={`input flex-1 min-w-40 text-left ${produtoSel ? 'text-gray-800' : 'text-gray-400'}`}
          >
            {produtoSel ? `${produtoSel.nome} (${produtoSel.unidade})` : `Selecionar ${ehProducao ? 'insumo' : 'produto'}...`}
          </button>
          <input
            type="number" min="0.001" step="0.001"
            placeholder="Quantidade"
            className="input w-32"
            value={form.quantidade}
            onChange={e => mudarQuantidade(e.target.value)}
          />
          <button onClick={adicionar} className="btn-primary">Adicionar</button>
        </div>

        {/* Reserva (OU): usa o cru se faltar o porcionado — só na Produção */}
        {mostrarReserva && (!reservaAberta && !form.altId ? (
          <button onClick={() => setReservaAberta(true)} className="text-xs text-red-700 underline">
            + adicionar reserva (OU cru, se faltar o porcionado)
          </button>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
            <p className="text-xs text-amber-800 font-medium">OU — usa o cru se faltar o porcionado</p>
            <div className="flex gap-2 flex-wrap items-center">
              <button onClick={() => setPickerAlt(true)} className={`input flex-1 min-w-40 text-left text-sm ${altSel ? 'text-gray-800' : 'text-gray-400'}`}>
                {altSel ? `${altSel.nome} (${altSel.unidade})` : 'Selecionar produto cru...'}
              </button>
              <input type="number" min="0.001" step="0.001" placeholder="Qtd cru" className="input w-24 text-sm"
                value={form.quantidadeAlt} onChange={e => setForm(f => ({ ...f, quantidadeAlt: e.target.value }))} />
              <button onClick={() => { setForm(f => ({ ...f, altId: '', quantidadeAlt: '' })); setReservaAberta(false); setSugestaoRaw(null) }} className="text-xs text-gray-400 underline">remover</button>
            </div>
          </div>
        ))}
      </div>

      {pickerAberto && (
        <SeletorProduto
          titulo={`Selecionar ${ehProducao ? 'insumo' : 'produto'}`}
          produtos={produtos}
          excluirIds={ingredientes.map(i => i.produto_id)}
          onEscolher={escolherPrincipal}
          onClose={() => setPickerAberto(false)}
        />
      )}
      {pickerAlt && (
        <SeletorProduto
          titulo="Produto cru (reserva)"
          produtos={produtos}
          excluirIds={[parseInt(form.produtoId)].filter(Boolean)}
          onEscolher={p => { setForm(f => ({ ...f, altId: String(p.id) })); setPickerAlt(false) }}
          onClose={() => setPickerAlt(false)}
        />
      )}

      {ingredientes.length === 0 ? (
        <p className="text-gray-400 text-sm">Nenhum {ehProducao ? 'insumo' : 'ingrediente'} cadastrado ainda.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-3 py-2">{ehProducao ? 'Insumo' : 'Ingrediente'}</th>
              <th className="text-right px-3 py-2">Qtd</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {ingredientes.map(ing => {
              const prod = produtos.find(p => p.id === ing.produto_id)
              const alt = ing.produto_alt_id ? produtos.find(p => p.id === ing.produto_alt_id) : null

              if (editId === ing.id) {
                const principal = produtos.find(p => p.id === parseInt(editForm.produtoId))
                const prodUn = principal?.unidade || 'un'
                const podeConverter = UNIDADES_MEDIDA.includes(prodUn)
                const reservaProd = editForm.altId ? produtos.find(p => p.id === parseInt(editForm.altId)) : null
                const principalEhPorcionado = !!principal && (principal.categoria === 'Porcionados'
                  || fichas.some(f => f.tipo_ficha === 'porcionado' && f.produto_saida_id === principal.id))
                return (
                  <tr key={ing.id} className="border-t border-gray-100 bg-amber-50/50">
                    <td colSpan={3} className="px-3 py-3">
                      <p className="text-sm font-medium text-gray-700 mb-2">{principal?.nome ?? 'Produto removido'}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="number" min="0" step="0.001" inputMode="decimal" autoFocus
                          className="input text-sm w-28"
                          value={editForm.quantidade}
                          onChange={e => setEditForm(f => ({ ...f, quantidade: e.target.value }))}
                          placeholder="Qtd"
                        />
                        {podeConverter ? (
                          <select className="input text-sm w-20" value={editForm.unidade} onChange={e => mudarUnidadeEdicao(e.target.value)}>
                            {UNIDADES_MEDIDA.map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                        ) : (
                          <span className="text-sm text-gray-500">{prodUn}</span>
                        )}
                      </div>

                      {/* Reserva "OU" (porcionado primeiro, cru de reserva) — só Produção/Prato */}
                      {mostrarReserva && (editForm.altId ? (
                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
                          <p className="text-xs text-amber-800 font-medium">Usa o porcionado primeiro; se faltar, o cru abaixo.</p>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-amber-700">OU {reservaProd?.nome ?? 'cru'}:</span>
                            <input
                              type="number" min="0" step="0.001" inputMode="decimal"
                              className="input text-sm w-24"
                              value={editForm.quantidadeAlt}
                              onChange={e => setEditForm(f => ({ ...f, quantidadeAlt: e.target.value }))}
                              placeholder="Qtd cru"
                            />
                            <span className="text-xs text-gray-500">{reservaProd?.unidade}</span>
                            <button onClick={removerPorcionadoNaEdicao} className="text-xs text-gray-400 underline ml-auto">remover porcionado</button>
                          </div>
                        </div>
                      ) : !principalEhPorcionado ? (
                        <button onClick={() => setEditPicker(true)} className="mt-2 block text-xs text-red-700 underline">
                          + usar porcionado (consome o porcionado primeiro; este vira a reserva)
                        </button>
                      ) : null)}

                      <div className="flex gap-2 mt-3">
                        <button onClick={() => salvarEdicao(ing)} className="btn-primary text-xs px-3 py-1.5">Salvar</button>
                        <button onClick={cancelarEdicao} className="btn-secondary text-xs px-3 py-1.5">Cancelar</button>
                      </div>

                      {editPicker && (
                        <SeletorProduto
                          titulo="Escolher porcionado (vira o insumo principal)"
                          produtos={porcionados}
                          excluirIds={ingredientes.map(i => i.produto_id)}
                          onEscolher={usarPorcionadoNaEdicao}
                          onClose={() => setEditPicker(false)}
                        />
                      )}
                    </td>
                  </tr>
                )
              }

              return (
                <tr key={ing.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-700">
                    {prod?.nome ?? 'Produto removido'}
                    {alt && <span className="block text-xs text-amber-700">↳ OU: {alt.nome} — {ing.quantidade_alt} {alt.unidade}</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono align-top">
                    {ing.quantidade} <span className="text-gray-400 text-xs">{prod?.unidade}</span>
                  </td>
                  <td className="px-3 py-2 text-right align-top whitespace-nowrap">
                    <button onClick={() => iniciarEdicao(ing)} className="text-blue-400 hover:text-blue-600 text-xs mr-2">Editar</button>
                    <button onClick={() => remover(ing.id)} className="text-red-400 hover:text-red-600 text-xs">Remover</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {aviso && (
        <Modal title="Atenção — vai usar o cru" onClose={() => setAviso(null)}>
          <div className="space-y-4">
            <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <span className="text-amber-600">⚠️</span>
              <p className="text-sm text-amber-800">Não há <strong>porcionado</strong> suficiente. Estes serão consumidos do <strong>cru</strong>:</p>
            </div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {aviso.map((a, i) => (
                <div key={i} className="text-sm border-b border-gray-100 py-1.5">
                  <p className="text-gray-700"><strong>{a.primNome}</strong> — tem {a.tem} {a.primUn}, precisa {a.precisa} {a.primUn}</p>
                  <p className="text-xs text-amber-700">→ usará {a.altQtd} {a.altUn} de {a.altNome}</p>
                </div>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setAviso(null)} className="btn-secondary flex-1">Voltar</button>
              <button onClick={executarProducao} disabled={produzindo} className="btn-primary flex-1">Produzir mesmo assim</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
