import { useState, useRef } from 'react'
import { useFichas, useProdutos, useFichaIngredientes, useTodosIngredientes } from '../hooks/useEstoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { analisarFichaTecnica, prepararImagem } from '../services/geminiVision'
import { registrarProducao, registrarEvento } from '../services/estoque'
import { converterUnidade as converterParaUnidadeProduto } from '../lib/unidades'
import { criarCalculadoraDeCusto, formatBRL } from '../lib/custos'
import { expandirArquivosParaImagens } from '../lib/arquivos'
import { Modal } from '../components/Modal'
import { Badge } from '../components/Badge'
import { SeletorProduto } from '../components/SeletorProduto'
import { X } from 'lucide-react'
import toast from 'react-hot-toast'

const CATEGORIAS = ['Pizza', 'Massa', 'Molho', 'Sobremesa', 'Bebida', 'Outros']
const UNIDADES_PRODUCAO = ['kg', 'g', 'l', 'ml']
const VAZIO_PRATO = { nome: '', categoria: 'Pizza', descricao: '', tipo_ficha: 'prato' }
const VAZIO_PRODUCAO = { nome: '', descricao: '', tipo_ficha: 'producao', produto_saida_id: '', unidade: 'kg', rendimento: '' }

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
  const [modalFoto, setModalFoto] = useState(false)
  const [fotoAnalise, setFotoAnalise] = useState(null)
  const [analisando, setAnalisando] = useState(false)
  const [resultadoFoto, setResultadoFoto] = useState(null)
  const [pickerIng, setPickerIng] = useState(null) // índice do insumo c/ seletor aberto
  const fileRefFoto = useRef()
  const cameraRefFoto = useRef()

  const apiKey = localStorage.getItem('gemini_api_key') || ''
  const ehProducao = aba === 'producao'

  async function analisarFoto(e) {
    const original = e.target.files[0]
    e.target.value = ''
    if (!original) return
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
  }

  // Acha o produto do estoque que melhor casa com um nome (exato, depois parcial).
  function acharProdutoPorNome(nome) {
    const b = (nome || '').trim().toLowerCase()
    if (!b) return null
    let prod = produtos.find(p => p.nome.toLowerCase() === b)
    if (!prod) prod = produtos.find(p => p.nome.toLowerCase().includes(b) || b.includes(p.nome.toLowerCase()))
    return prod || null
  }

  async function processarFoto() {
    if (!fotoAnalise) return
    if (!apiKey) return toast.error('Configure a chave da API na aba 📷 Foto IA primeiro')
    setAnalisando(true)
    try {
      const { base64, mimeType } = await prepararImagem(fotoAnalise.file)
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
        .insert({ organizacao_id: orgId, nome, categoria: 'Produção', unidade, quantidade: 0, estoque_minimo: 0 })
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
    f.nome.toLowerCase().includes(busca.toLowerCase())
  )

  function trocarAba(novaAba) {
    setAba(novaAba)
    setDetalhe(null)
  }

  function abrirNovo() {
    setForm(ehProducao ? VAZIO_PRODUCAO : VAZIO_PRATO)
    setModal('novo')
  }
  function abrirEditar(f) {
    const unidade = produtos.find(p => p.id === f.produto_saida_id)?.unidade || 'kg'
    setForm({ ...f, produto_saida_id: f.produto_saida_id ?? '', rendimento: f.rendimento ?? '', unidade })
    setModal(f)
  }
  function fechar() { setModal(null) }

  async function salvar() {
    if (!form.nome.trim()) return toast.error('Nome obrigatório')
    const tipo = form.tipo_ficha || 'prato'
    let data
    if (tipo === 'producao') {
      if (!form.rendimento || parseFloat(form.rendimento) <= 0) return toast.error('Informe o rendimento (maior que zero)')
      const nome = form.nome.trim()
      const unidade = form.unidade || 'kg'
      const orgId = session.organizacaoId

      // O produto gerado é o próprio nome da ficha — cria no estoque (ou
      // reaproveita se já existir um produto com o mesmo nome). Na edição,
      // sincroniza nome/unidade do produto vinculado.
      let produtoSaidaId = form.produto_saida_id ? parseInt(form.produto_saida_id) : null
      if (produtoSaidaId) {
        await supabase.from('produtos').update({ nome, unidade }).eq('id', produtoSaidaId)
      } else {
        const existente = produtos.find(p => p.nome.trim().toLowerCase() === nome.toLowerCase())
        if (existente) {
          produtoSaidaId = existente.id
          await supabase.from('produtos').update({ unidade }).eq('id', produtoSaidaId)
        } else {
          const { data: novoProd, error: errProd } = await supabase
            .from('produtos')
            .insert({ organizacao_id: orgId, nome, categoria: 'Produção', unidade, quantidade: 0, estoque_minimo: 0 })
            .select()
            .single()
          if (errProd) return toast.error(errProd.message)
          produtoSaidaId = novoProd.id
          await registrarEvento('produto_novo', { produtoId: produtoSaidaId, nome })
        }
      }

      data = {
        nome,
        categoria: 'Produção',
        descricao: form.descricao || '',
        tipo_ficha: 'producao',
        produto_saida_id: produtoSaidaId,
        rendimento: parseFloat(form.rendimento),
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
    const ehProd = f.tipo_ficha === 'producao'
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

      {/* Alternância Pratos | Produção */}
      <div className="flex bg-gray-100 rounded-xl p-1 gap-1 max-w-sm">
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
      </div>

      <p className="text-xs text-gray-500">
        {ehProducao
          ? 'Receitas de fabricação: ao produzir, consomem insumos e geram um produto para o estoque (ex: massa, molho).'
          : 'Receitas de pratos vendidos: ao registrar a venda, consomem os ingredientes do estoque.'}
      </p>

      <input
        placeholder="Buscar ficha..."
        value={busca}
        onChange={e => setBusca(e.target.value)}
        className="input w-full"
      />

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
                    : (f.descricao && <p className="text-xs text-gray-400 mt-1 line-clamp-2">{f.descricao}</p>)
                  }
                </div>
                <Badge color={f.tipo_ficha === 'producao' ? 'blue' : 'orange'}>
                  {f.tipo_ficha === 'producao' ? 'Produção' : f.categoria}
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

      {detalhe && <DetalheIngredientes ficha={detalhe} custoUnit={custoUnit} />}

      {modal && (
        <Modal title={modal === 'novo' ? (form.tipo_ficha === 'producao' ? 'Nova Ficha de Produção' : 'Nova Ficha de Prato') : 'Editar Ficha'} onClose={fechar}>
          <div className="space-y-3">
            <div>
              <label className="label">{form.tipo_ficha === 'producao' ? 'Nome do produto gerado *' : 'Nome *'}</label>
              <input className="input" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder={form.tipo_ficha === 'producao' ? 'Ex: Massa de Pizza' : 'Ex: Pizza Margherita'} />
              {form.tipo_ficha === 'producao' && (
                <p className="text-xs text-gray-400 mt-1">Este produto será criado no estoque automaticamente.</p>
              )}
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
            ) : (
              <div>
                <label className="label">Categoria</label>
                <select className="input" value={form.categoria} onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))}>
                  {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="label">Descrição</label>
              <textarea className="input resize-none" rows={3} value={form.descricao} onChange={e => setForm(f => ({ ...f, descricao: e.target.value }))} placeholder="Descrição opcional..." />
            </div>
            <button onClick={salvar} className="btn-primary w-full">Salvar</button>
          </div>
        </Modal>
      )}

      {modalFoto && (
        <Modal title="Importar Ficha por Foto" onClose={() => { setModalFoto(false); setFotoAnalise(null); setResultadoFoto(null); setPickerIng(null) }}>
          <div className="space-y-4">
            <div className="border-2 border-dashed border-gray-300 rounded-xl p-4 text-center space-y-3">
              {fotoAnalise ? (
                <img src={fotoAnalise.url} alt="" className="max-h-48 mx-auto rounded-lg object-contain" />
              ) : (
                <p className="text-gray-400 text-sm">Foto da ficha técnica, cardápio ou receita</p>
              )}
              <div className="flex gap-2 justify-center flex-wrap">
                <button onClick={() => fileRefFoto.current.click()} className="btn-secondary text-sm">📁 Arquivo</button>
                <button onClick={() => cameraRefFoto.current.click()} className="btn-secondary text-sm">📷 Câmera</button>
              </div>
              <input ref={fileRefFoto} type="file" accept="image/*,application/pdf" className="hidden" onChange={analisarFoto} />
              <input ref={cameraRefFoto} type="file" accept="image/*" capture="environment" className="hidden" onChange={analisarFoto} />
            </div>

            {fotoAnalise && !resultadoFoto && (
              <button onClick={processarFoto} disabled={analisando} className="btn-primary w-full disabled:opacity-50">
                {analisando ? 'Analisando...' : '🔍 Analisar com IA'}
              </button>
            )}

            {resultadoFoto && (
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
          </div>
        </Modal>
      )}
    </div>
  )
}

function DetalheIngredientes({ ficha, custoUnit }) {
  const produtos = useProdutos()
  const ingredientes = useFichaIngredientes(ficha.id)
  const [form, setForm] = useState({ produtoId: '', quantidade: '' })
  const [lotes, setLotes] = useState('')
  const [produzindo, setProduzindo] = useState(false)
  const [pickerAberto, setPickerAberto] = useState(false)
  const produtoSel = produtos.find(p => p.id === parseInt(form.produtoId))

  const ehProducao = ficha.tipo_ficha === 'producao'
  const prodGerado = produtos.find(p => p.id === ficha.produto_saida_id)

  // Custo total dos insumos desta ficha (resolve produtos de produção também)
  const custoTotal = ingredientes.reduce((s, ing) => s + (ing.quantidade || 0) * (custoUnit ? custoUnit(ing.produto_id) : 0), 0)
  const custoPorUnidade = ehProducao && ficha.rendimento > 0 ? custoTotal / ficha.rendimento : 0

  async function adicionar() {
    if (!form.produtoId || !form.quantidade) return toast.error('Preencha produto e quantidade')
    const existe = ingredientes.find(i => i.produto_id === parseInt(form.produtoId))
    if (existe) return toast.error('Ingrediente já adicionado')
    const { error } = await supabase.from('ficha_ingredientes').insert({
      ficha_id: ficha.id,
      produto_id: parseInt(form.produtoId),
      quantidade: parseFloat(form.quantidade),
    })
    if (error) return toast.error(error.message)
    setForm({ produtoId: '', quantidade: '' })
    toast.success('Ingrediente adicionado!')
  }

  async function remover(id) {
    await supabase.from('ficha_ingredientes').delete().eq('id', id)
  }

  async function produzir() {
    if (ingredientes.length === 0) return toast.error('Adicione os insumos antes de produzir')
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
            {ficha.rendimento ? <> — rende <strong>{ficha.rendimento} {prodGerado?.unidade || ''}</strong> por lote</> : ' — defina o rendimento'}
          </p>
          <p className="text-sm text-gray-700">
            Custo por lote: <strong className="text-gray-800">{formatBRL(custoTotal)}</strong>
            {ficha.rendimento > 0 && <> · por {prodGerado?.unidade || 'un'}: <strong className="text-gray-800">{formatBRL(custoPorUnidade)}</strong></>}
          </p>
          <div className="flex gap-2 items-end">
            <div>
              <label className="label">Lotes a produzir</label>
              <input type="number" min="1" step="1" className="input w-28" placeholder="Ex: 1" value={lotes} onChange={e => setLotes(e.target.value)} />
            </div>
            <button onClick={produzir} disabled={produzindo} className="btn-primary disabled:opacity-50">
              {produzindo ? 'Produzindo...' : '⚙️ Produzir'}
            </button>
          </div>
          <p className="text-xs text-gray-500">Consome os insumos abaixo e adiciona {prodGerado?.nome || 'o produto'} ao estoque.</p>
        </div>
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
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
          onChange={e => setForm(f => ({ ...f, quantidade: e.target.value }))}
        />
        <button onClick={adicionar} className="btn-primary">Adicionar</button>
      </div>

      {pickerAberto && (
        <SeletorProduto
          titulo={`Selecionar ${ehProducao ? 'insumo' : 'produto'}`}
          produtos={produtos}
          excluirIds={ingredientes.map(i => i.produto_id)}
          onEscolher={p => { setForm(f => ({ ...f, produtoId: String(p.id) })); setPickerAberto(false) }}
          onClose={() => setPickerAberto(false)}
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
              return (
                <tr key={ing.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-700">{prod?.nome ?? 'Produto removido'}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {ing.quantidade} <span className="text-gray-400 text-xs">{prod?.unidade}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => remover(ing.id)} className="text-red-400 hover:text-red-600 text-xs">Remover</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
