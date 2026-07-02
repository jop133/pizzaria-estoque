import { useState, useRef } from 'react'
import { useProdutos, useFichas, useTodosIngredientes } from '../hooks/useEstoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { importarProdutosCSV, exportarEstoqueCSV, exportarEstoquePDF } from '../services/importExport'
import { fatorUnidade, converterUnidade } from '../lib/unidades'
import { criarCalculadoraDeCusto, ehProdutoDeProducao, formatBRL } from '../lib/custos'
import { registrarEvento } from '../services/estoque'
import { lerXlsx, matchearPrecos, normalizarPreco, mediaPrecos, criarGrupoNovo } from '../lib/precos'
import { agruparPorTipo } from '../services/geminiVision'
import { Modal } from '../components/Modal'
import { Badge } from '../components/Badge'
import { Search, ArrowLeftRight, X } from 'lucide-react'
import toast from 'react-hot-toast'

const CATEGORIAS = ['Laticínios e Frios', 'Proteínas', 'Hortifruti', 'Mercearia', 'Produções Internas', 'Bebidas', 'Embalagens e Etiquetas', 'Limpeza', 'Porcionados', 'Outros']
const UNIDADES = ['kg', 'g', 'L', 'ml', 'un', 'cx', 'pct', 'fardo']
const VAZIO = { nome: '', categoria: 'Outros', unidade: 'kg', quantidade: 0, estoque_minimo: 0, preco: 0 }

export function Estoque() {
  const produtos = useProdutos()
  const fichas = useFichas()
  const ingredientes = useTodosIngredientes()
  const custoUnit = criarCalculadoraDeCusto(produtos, fichas, ingredientes)
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(VAZIO)
  const [busca, setBusca] = useState('')
  const [filtroCategoria, setFiltroCategoria] = useState('')
  const [selecionados, setSelecionados] = useState(new Set())
  const fileRef = useRef()
  const xlsxRef = useRef()

  // --- Fluxo de importação de preços via xlsx ---
  const [precoFase, setPrecoFase] = useState('idle') // idle | lendo | confirmando | aplicando
  const [gruposPreco, setGruposPreco] = useState([])
  const [pickerPreco, setPickerPreco] = useState(null) // { grupoId } — vincular a produto existente
  const [buscaPicker, setBuscaPicker] = useState('')
  const [pickerGrupo, setPickerGrupo] = useState(null) // { grupoId } — juntar com outro da lista
  const [buscaGrupo, setBuscaGrupo] = useState('')
  const [precoFiltro, setPrecoFiltro] = useState('todos') // todos | pendentes | confirmados
  const [precoBusca, setPrecoBusca] = useState('')

  const filtrados = produtos.filter(p => {
    const okBusca = p.nome.toLowerCase().includes(busca.toLowerCase())
    const okCat = !filtroCategoria || p.categoria === filtroCategoria
    return okBusca && okCat
  })

  const todosSelecionados = filtrados.length > 0 && filtrados.every(p => selecionados.has(p.id))

  function toggleSelecionado(id) {
    setSelecionados(prev => {
      const novo = new Set(prev)
      novo.has(id) ? novo.delete(id) : novo.add(id)
      return novo
    })
  }

  function toggleTodos() {
    if (todosSelecionados) {
      setSelecionados(new Set())
    } else {
      setSelecionados(new Set(filtrados.map(p => p.id)))
    }
  }

  async function excluirSelecionados() {
    if (selecionados.size === 0) return
    if (!confirm(`Excluir ${selecionados.size} produto(s) selecionado(s)?`)) return
    const alvos = produtos.filter(p => selecionados.has(p.id))
    const { error } = await supabase.from('produtos').delete().in('id', [...selecionados])
    if (error) return toast.error('Erro ao excluir')
    for (const p of alvos) await registrarEvento('produto_excluido', { nome: p.nome })
    setSelecionados(new Set())
    toast.success(`${selecionados.size} produto(s) excluído(s)!`)
  }

  function abrirNovo() { setForm(VAZIO); setModal('novo') }
  function abrirEditar(p) { setForm({ ...p }); setModal(p) }
  function fechar() { setModal(null) }

  async function salvar() {
    if (!form.nome.trim()) return toast.error('Nome obrigatório')
    const data = {
      nome: form.nome.trim(),
      categoria: form.categoria,
      unidade: form.unidade,
      quantidade: parseFloat(form.quantidade) || 0,
      estoque_minimo: parseFloat(form.estoque_minimo) || 0,
      preco: parseFloat(form.preco) || 0,
    }
    if (modal === 'novo') {
      const { data: novo, error } = await supabase.from('produtos').insert({ ...data, organizacao_id: session.organizacaoId }).select().single()
      if (error) return toast.error(error.message)
      await registrarEvento('produto_novo', { produtoId: novo?.id, nome: data.nome })
      toast.success('Produto adicionado!')
    } else {
      const { error } = await supabase.from('produtos').update(data).eq('id', modal.id)
      if (error) return toast.error(error.message)
      // Registra a alteração exata de quantidade no histórico (só quando a
      // unidade não mudou; com troca de unidade os números não são comparáveis).
      let detalhe = ''
      const antes = Math.round((modal.quantidade || 0) * 1000) / 1000
      const depois = Math.round(data.quantidade * 1000) / 1000
      const delta = Math.round((depois - antes) * 1000) / 1000
      if (delta !== 0 && modal.unidade === form.unidade) {
        detalhe = `${antes} → ${depois} ${form.unidade} (${delta > 0 ? '+' : ''}${delta})`
      }
      await registrarEvento('produto_editado', { produtoId: modal.id, nome: data.nome, detalhe })

      // Se a unidade mudou (entre compatíveis), converte as quantidades usadas
      // deste produto nas fichas técnicas, para manterem o valor real.
      const fator = fatorUnidade(modal.unidade, form.unidade)
      if (modal.unidade !== form.unidade && fator !== 1) {
        const { data: ings } = await supabase
          .from('ficha_ingredientes')
          .select('id, quantidade')
          .eq('produto_id', modal.id)
        for (const ing of ings || []) {
          await supabase
            .from('ficha_ingredientes')
            .update({ quantidade: Math.round(ing.quantidade * fator * 1000) / 1000 })
            .eq('id', ing.id)
        }
      }
      toast.success('Produto atualizado!')
    }
    fechar()
  }

  async function excluir(p) {
    if (!confirm('Excluir este produto?')) return
    await supabase.from('produtos').delete().eq('id', p.id)
    await registrarEvento('produto_excluido', { nome: p.nome })
    toast.success('Produto excluído')
    fechar()
  }

  async function importar(e) {
    const file = e.target.files[0]
    if (!file) return
    try {
      const n = await importarProdutosCSV(file)
      toast.success(`${n} produtos importados!`)
    } catch {
      toast.error('Erro ao importar CSV')
    }
    e.target.value = ''
  }

  // ---------------------------------------------------------------------------
  // Importação de preços via xlsx
  // ---------------------------------------------------------------------------

  async function lerArquivoPrecos(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setPrecoFase('lendo')
    const t = toast.loading('Lendo planilha...')
    try {
      const itens = await lerXlsx(file)
      if (itens.length === 0) {
        toast.dismiss(t)
        toast.error('Nenhum produto com preço encontrado na planilha.')
        setPrecoFase('idle')
        return
      }
      // Agrupamento por marca via IA (1 chamada de texto). Remove marca/peso e
      // mantém o tipo, p/ unir "Batata Palito UAI/MC CAIN" e separar "70%/40%".
      // Sem chave ou em caso de falha, cai no agrupamento heurístico local.
      let mapaBase = {}
      const apiKey = localStorage.getItem('gemini_api_key') || ''
      if (apiKey) {
        toast.loading('Agrupando por tipo (IA)...', { id: t })
        try {
          mapaBase = await agruparPorTipo(itens.map(i => i.nome), apiKey)
        } catch { mapaBase = {} }
      }
      const grupos = matchearPrecos(itens, produtos, mapaBase)
      setGruposPreco(grupos)
      setPrecoFase('confirmando')
      toast.dismiss(t)
      toast.success(`${itens.length} item(ns) lido(s). Confira antes de salvar.`)
    } catch (err) {
      toast.dismiss(t)
      toast.error('Erro ao ler planilha: ' + (err?.message || 'verifique o arquivo'), { duration: 6000 })
      setPrecoFase('idle')
    }
  }

  function patchGrupoPreco(id, patch) {
    setGruposPreco(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g))
  }

  function confirmarGrupoPreco(id) { patchGrupoPreco(id, { confirmado: true }) }
  function pularGrupoPreco(id)     { patchGrupoPreco(id, { pulado: true, confirmado: false }) }
  function ignorarGrupoPreco(id)   { setGruposPreco(prev => prev.filter(g => g.id !== id)) }

  function editarPrecoGrupo(id, valor) {
    setGruposPreco(prev => prev.map(g => g.id === id ? { ...g, preco: valor, precoEditado: true } : g))
  }

  function confirmarTodosAltosPreco() {
    setGruposPreco(prev => prev.map(g =>
      (g.produtoId && !g.pulado && g.confianca === 'alta') ? { ...g, confirmado: true } : g
    ))
  }

  // Recalcula os preços normalizados de um grupo para uma nova unidade alvo.
  function recalcularPrecos(itens, unidadeAlvo) {
    const novos = itens.map(it => {
      const n = normalizarPreco(it.precoOriginal, it.nomeOriginal, it.unidadeOriginal, unidadeAlvo)
      return { ...it, precoNorm: n.precoNorm, incerto: n.incerto, dividiu: n.dividiu, pesoVal: n.pesoVal, pesoU: n.pesoU }
    })
    return { itens: novos, media: mediaPrecos(novos) }
  }

  // Vincula o grupo a um produto existente (vira card 'match').
  function escolherProdutoPreco(grupoId, produto) {
    setGruposPreco(prev => prev.map(g => {
      if (g.id !== grupoId) return g
      const { itens, media } = recalcularPrecos(g.itens, produto.unidade)
      return {
        ...g, tipo: 'match', itens,
        produtoId: produto.id, produtoNome: produto.nome, produtoUnidade: produto.unidade,
        confianca: 'alta', precoCalculado: media, preco: String(media), precoEditado: false,
      }
    }))
    setPickerPreco(null)
    setBuscaPicker('')
  }

  // Desvincula um grupo inteiro do produto: vira proposta de cadastro (produto novo).
  function desvincularGrupo(grupoId) {
    setGruposPreco(prev => prev.map(g => {
      if (g.id !== grupoId || g.tipo !== 'match') return g
      const raws = g.itens.map(it => ({
        nome: it.nomeOriginal, preco: it.precoOriginal, unidade: it.unidadeOriginal, aba: it.aba,
      }))
      return { ...criarGrupoNovo(raws), id: g.id }
    }))
  }

  // Remove um item (uma marca) de um grupo e o transforma num grupo 'novo' avulso.
  function removerItemPreco(grupoId, itemId) {
    setGruposPreco(prev => {
      let removido = null
      const mapeado = prev.map(g => {
        if (g.id !== grupoId || g.itens.length <= 1) return g
        const item = g.itens.find(it => it.id === itemId)
        if (!item) return g
        removido = item
        const itens = g.itens.filter(it => it.id !== itemId)
        const media = mediaPrecos(itens)
        return { ...g, itens, precoCalculado: media, preco: g.precoEditado ? g.preco : String(media) }
      })
      if (!removido) return prev
      const novo = criarGrupoNovo([{
        nome: removido.nomeOriginal, preco: removido.precoOriginal,
        unidade: removido.unidadeOriginal, aba: removido.aba,
      }])
      return [...mapeado, novo]
    })
  }

  // Junta um grupo (origem) em outro da lista (destino): mescla os itens e
  // recalcula a média na unidade do destino. A origem é removida.
  function mesclarGruposPreco(origemId, destinoId) {
    if (origemId === destinoId) { setPickerGrupo(null); setBuscaGrupo(''); return }
    setGruposPreco(prev => {
      const origem = prev.find(g => g.id === origemId)
      const destino = prev.find(g => g.id === destinoId)
      if (!origem || !destino) return prev
      const unidadeAlvo = destino.tipo === 'match' ? destino.produtoUnidade : destino.unidadeNova
      const { itens, media } = recalcularPrecos([...destino.itens, ...origem.itens], unidadeAlvo)
      return prev
        .filter(g => g.id !== origemId)
        .map(g => g.id === destinoId
          ? { ...g, itens, precoCalculado: media, preco: g.precoEditado ? g.preco : String(media), confirmado: false }
          : g)
    })
    setPickerGrupo(null)
    setBuscaGrupo('')
  }

  // Handlers de card 'produto novo'
  function editarNomeNovo(id, valor) { patchGrupoPreco(id, { nomeNovo: valor }) }
  function editarCategoriaNova(id, valor) { patchGrupoPreco(id, { categoriaNova: valor }) }
  function editarUnidadeNova(id, valor) {
    setGruposPreco(prev => prev.map(g => {
      if (g.id !== id) return g
      const { itens, media } = recalcularPrecos(g.itens, valor)
      return { ...g, unidadeNova: valor, itens, precoCalculado: media, preco: g.precoEditado ? g.preco : String(media) }
    }))
  }

  function fecharPrecos() {
    setGruposPreco([])
    setPrecoFase('idle')
    setPickerPreco(null)
    setBuscaPicker('')
    setPickerGrupo(null)
    setBuscaGrupo('')
    setPrecoFiltro('todos')
    setPrecoBusca('')
  }

  async function aplicarPrecos() {
    const atualizar = gruposPreco.filter(g => g.confirmado && g.tipo === 'match' && g.produtoId)
    const cadastrar = gruposPreco.filter(g => g.confirmado && g.tipo === 'novo')
    if (atualizar.length === 0 && cadastrar.length === 0) {
      return toast.error('Confirme ao menos um produto antes de aplicar.')
    }
    setPrecoFase('aplicando')
    let ok = 0, criados = 0, erros = 0

    // Atualiza preços de produtos existentes
    for (const g of atualizar) {
      const v = parseFloat(String(g.preco).replace(',', '.'))
      if (isNaN(v) || v < 0) { erros++; continue }
      const { error } = await supabase.from('produtos').update({ preco: v }).eq('id', g.produtoId)
      if (error) erros++; else ok++
    }

    // Cadastra produtos novos
    for (const g of cadastrar) {
      const nome = String(g.nomeNovo || '').trim()
      const v = parseFloat(String(g.preco).replace(',', '.'))
      if (!nome || isNaN(v) || v < 0) { erros++; continue }
      const { data: novo, error } = await supabase.from('produtos').insert({
        organizacao_id: session.organizacaoId,
        nome,
        categoria: g.categoriaNova || 'Outros',
        unidade: g.unidadeNova || 'un',
        quantidade: 0,
        estoque_minimo: 0,
        preco: v,
      }).select().single()
      if (error) { erros++; continue }
      await registrarEvento('produto_novo', { produtoId: novo?.id, nome })
      criados++
    }

    if (ok > 0) toast.success(`${ok} preço(s) atualizado(s)!`)
    if (criados > 0) toast.success(`${criados} produto(s) cadastrado(s)!`)
    if (erros > 0) toast.error(`${erros} item(ns) não puderam ser processados.`)
    fecharPrecos()
  }

  const gruposVisiveis    = gruposPreco.filter(g => !g.pulado)
  const gruposComProduto  = gruposVisiveis.filter(g => g.tipo === 'match')
  const gruposNovos       = gruposVisiveis.filter(g => g.tipo === 'novo')
  const confirmadosMatch  = gruposComProduto.filter(g => g.confirmado)
  const confirmadosNovos  = gruposNovos.filter(g => g.confirmado)
  const totalConfirmados  = confirmadosMatch.length + confirmadosNovos.length
  const altosPreco        = gruposComProduto.filter(g => g.confianca === 'alta' && !g.confirmado)
  const produtosPicker    = produtos.filter(p =>
    !buscaPicker || p.nome.toLowerCase().includes(buscaPicker.toLowerCase())
  )

  // Filtro de visualização da tela de confirmação
  function passaFiltroPreco(g) {
    if (precoBusca) {
      const nome = (g.tipo === 'match' ? g.produtoNome : g.nomeNovo) || ''
      if (!nome.toLowerCase().includes(precoBusca.toLowerCase())) return false
    }
    if (precoFiltro === 'pendentes') return !g.confirmado
    if (precoFiltro === 'confirmados') return g.confirmado
    return true
  }
  const matchFiltrados = gruposComProduto.filter(passaFiltroPreco)
  const novosFiltrados = gruposNovos.filter(passaFiltroPreco)

  // ---------------------------------------------------------------------------
  // TELA DE CONFIRMAÇÃO DE PREÇOS
  // ---------------------------------------------------------------------------
  if (precoFase === 'confirmando' || precoFase === 'aplicando') {
    return (
      <div className="space-y-4 max-w-lg mx-auto pb-28">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-800">Conferir preços</h1>
          <button onClick={fecharPrecos} className="text-sm text-gray-500 underline">Cancelar</button>
        </div>

        {/* Resumo + ações em massa */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-gray-600">
            <strong>{gruposComProduto.length}</strong> com preço a atualizar
            {gruposNovos.length > 0 && <> · <strong>{gruposNovos.length}</strong> para cadastrar</>}.
            Confira cada um e toque em <strong>Confirmar</strong>.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="bg-green-50 text-green-700 px-2 py-1 rounded-full">✓ {totalConfirmados} confirmados</span>
            {gruposComProduto.filter(g => g.confianca === 'media' && !g.confirmado).length > 0 && (
              <span className="bg-yellow-50 text-yellow-700 px-2 py-1 rounded-full">
                ? {gruposComProduto.filter(g => g.confianca === 'media' && !g.confirmado).length} revisar
              </span>
            )}
            {gruposNovos.length > 0 && (
              <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-full">+ {gruposNovos.length} novos</span>
            )}
          </div>
          {altosPreco.length > 0 && (
            <button onClick={confirmarTodosAltosPreco} className="btn-secondary w-full text-sm">
              ✓ Confirmar os {altosPreco.length} com alta confiança
            </button>
          )}
        </div>

        {/* Filtros + busca */}
        <div className="space-y-2">
          <div className="flex gap-2">
            {[
              { v: 'todos', label: `Todos (${gruposVisiveis.length})` },
              { v: 'pendentes', label: `A confirmar (${gruposVisiveis.length - totalConfirmados})` },
              { v: 'confirmados', label: `Confirmados (${totalConfirmados})` },
            ].map(f => (
              <button
                key={f.v}
                onClick={() => setPrecoFiltro(f.v)}
                className={`flex-1 text-xs font-medium px-2 py-2 rounded-lg border transition-colors ${
                  precoFiltro === f.v ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-gray-200 text-gray-600'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              placeholder="Buscar na lista..."
              value={precoBusca}
              onChange={e => setPrecoBusca(e.target.value)}
              className="input pl-9"
            />
          </div>
        </div>

        {(matchFiltrados.length === 0 && novosFiltrados.length === 0) && (
          <p className="text-sm text-gray-400 text-center py-8">Nenhum item neste filtro.</p>
        )}

        {/* Cards de produto existente (atualizar preço) */}
        {matchFiltrados.map(g => (
          <PrecoCard
            key={g.id}
            grupo={g}
            onTrocar={() => { setBuscaPicker(''); setPickerPreco({ grupoId: g.id }) }}
            onDesvincular={() => desvincularGrupo(g.id)}
            onRemoverItem={itemId => removerItemPreco(g.id, itemId)}
            onEditarPreco={v => editarPrecoGrupo(g.id, v)}
            onConfirmar={() => confirmarGrupoPreco(g.id)}
            onPular={() => pularGrupoPreco(g.id)}
          />
        ))}

        {/* Produtos novos (cadastrar) */}
        {novosFiltrados.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-blue-700 flex items-center gap-2 pt-2">
              <span className="text-lg">+</span> Cadastrar produtos novos ({novosFiltrados.length})
            </p>
            <p className="text-xs text-gray-500 -mt-1">
              Não foram encontrados no estoque. Confira nome, unidade e categoria antes de cadastrar.
            </p>
            {novosFiltrados.map(g => (
              <NovoProdutoCard
                key={g.id}
                grupo={g}
                categorias={CATEGORIAS}
                unidades={UNIDADES}
                onEditarNome={v => editarNomeNovo(g.id, v)}
                onEditarUnidade={v => editarUnidadeNova(g.id, v)}
                onEditarCategoria={v => editarCategoriaNova(g.id, v)}
                onEditarPreco={v => editarPrecoGrupo(g.id, v)}
                onRemoverItem={itemId => removerItemPreco(g.id, itemId)}
                onVincular={() => { setBuscaPicker(''); setPickerPreco({ grupoId: g.id }) }}
                onVincularLista={gruposVisiveis.length > 1
                  ? () => { setBuscaGrupo(''); setPickerGrupo({ grupoId: g.id }) }
                  : null}
                onConfirmar={() => confirmarGrupoPreco(g.id)}
                onIgnorar={() => ignorarGrupoPreco(g.id)}
              />
            ))}
          </div>
        )}

        {/* Rodapé fixo */}
        <div className="fixed bottom-16 left-0 right-0 p-3 bg-gradient-to-t from-gray-50 via-gray-50 to-transparent">
          <div className="max-w-lg mx-auto">
            <button
              onClick={aplicarPrecos}
              disabled={precoFase === 'aplicando' || totalConfirmados === 0}
              className="btn-primary w-full text-base py-3 disabled:opacity-50 shadow-lg"
            >
              {precoFase === 'aplicando' ? 'Salvando...' : (() => {
                const partes = []
                if (confirmadosMatch.length) partes.push(`${confirmadosMatch.length} preço(s)`)
                if (confirmadosNovos.length) partes.push(`${confirmadosNovos.length} novo(s)`)
                return partes.length ? `Salvar ${partes.join(' + ')}` : 'Confirme ao menos um item'
              })()}
            </button>
          </div>
        </div>

        {/* Seletor de produto */}
        {pickerPreco && (
          <Modal title="Escolher produto" onClose={() => { setPickerPreco(null); setBuscaPicker('') }}>
            <div className="space-y-3">
              <div className="relative">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  autoFocus
                  placeholder="Buscar produto..."
                  value={buscaPicker}
                  onChange={e => setBuscaPicker(e.target.value)}
                  className="input pl-9"
                />
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
                {produtosPicker.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">Nenhum produto encontrado.</p>
                ) : produtosPicker.map(p => (
                  <button
                    key={p.id}
                    onClick={() => escolherProdutoPreco(pickerPreco.grupoId, p)}
                    className="w-full text-left py-3 px-1 hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-sm font-medium text-gray-800">{p.nome}</span>
                    <span className="text-xs text-gray-400 ml-2">{p.unidade}</span>
                  </button>
                ))}
              </div>
            </div>
          </Modal>
        )}

        {/* Seletor para juntar com outro grupo da lista */}
        {pickerGrupo && (() => {
          const candidatos = gruposVisiveis
            .filter(g => g.id !== pickerGrupo.grupoId)
            .map(g => ({
              id: g.id,
              nome: g.tipo === 'match' ? g.produtoNome : g.nomeNovo,
              unidade: g.tipo === 'match' ? g.produtoUnidade : g.unidadeNova,
              tag: g.tipo === 'match' ? 'já no estoque' : 'novo',
            }))
            .filter(c => !buscaGrupo || c.nome.toLowerCase().includes(buscaGrupo.toLowerCase()))
          return (
            <Modal title="Vincular com outro item da lista" onClose={() => { setPickerGrupo(null); setBuscaGrupo('') }}>
              <div className="space-y-3">
                <p className="text-xs text-gray-500">
                  Os itens deste produto serão movidos para o item escolhido, e o preço recalculado.
                </p>
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    autoFocus
                    placeholder="Buscar na lista..."
                    value={buscaGrupo}
                    onChange={e => setBuscaGrupo(e.target.value)}
                    className="input pl-9"
                  />
                </div>
                <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
                  {candidatos.length === 0 ? (
                    <p className="text-sm text-gray-400 py-6 text-center">Nenhum item na lista.</p>
                  ) : candidatos.map(c => (
                    <button
                      key={c.id}
                      onClick={() => mesclarGruposPreco(pickerGrupo.grupoId, c.id)}
                      className="w-full text-left py-3 px-1 hover:bg-gray-50 transition-colors flex items-center justify-between gap-2"
                    >
                      <span className="text-sm font-medium text-gray-800 truncate">{c.nome}</span>
                      <span className="text-xs text-gray-400 shrink-0">{c.tag} · {c.unidade}</span>
                    </button>
                  ))}
                </div>
              </div>
            </Modal>
          )
        })()}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // TELA NORMAL DO ESTOQUE
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">Estoque</h1>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => xlsxRef.current.click()}
            disabled={precoFase === 'lendo'}
            className="btn-secondary text-sm disabled:opacity-50"
          >
            💰 {precoFase === 'lendo' ? 'Lendo...' : 'Importar Preços'}
          </button>
          <button onClick={() => fileRef.current.click()} className="btn-secondary text-sm">📥 Importar CSV</button>
          <button onClick={() => exportarEstoqueCSV(filtrados)} className="btn-secondary text-sm">📤 CSV</button>
          <button onClick={() => exportarEstoquePDF(filtrados)} className="btn-secondary text-sm">📄 PDF</button>
          <button onClick={abrirNovo} className="btn-primary text-sm">+ Novo Produto</button>
        </div>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={importar} />
        <input ref={xlsxRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={lerArquivoPrecos} />
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          placeholder="Buscar produto..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          className="input flex-1 min-w-40"
        />
        <select value={filtroCategoria} onChange={e => setFiltroCategoria(e.target.value)} className="input w-auto">
          <option value="">Todas categorias</option>
          {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      {selecionados.size > 0 && (
        <div className="flex items-center justify-between bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <p className="text-sm font-medium text-red-700">{selecionados.size} produto(s) selecionado(s)</p>
          <div className="flex gap-2">
            <button onClick={() => setSelecionados(new Set())} className="text-xs text-gray-500 underline">Limpar</button>
            <button onClick={excluirSelecionados} className="btn-danger text-sm py-1">🗑 Excluir selecionados</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtrados.length === 0 ? (
          <p className="text-gray-400 text-sm p-6 text-center">Nenhum produto encontrado.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" checked={todosSelecionados} onChange={toggleTodos} className="w-4 h-4 accent-red-600" />
                </th>
                <th className="text-left px-4 py-3">Produto</th>
                <th className="text-left px-4 py-3 hidden sm:table-cell">Categoria</th>
                <th className="text-right px-4 py-3">Qtd</th>
                <th className="text-right px-4 py-3 hidden md:table-cell">Mínimo</th>
                <th className="text-center px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map(p => {
                const baixo = p.quantidade <= (p.estoque_minimo || 0)
                return (
                  <tr key={p.id} className={`border-t border-gray-100 hover:bg-gray-50 ${selecionados.has(p.id) ? 'bg-red-50' : ''}`}>
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selecionados.has(p.id)} onChange={() => toggleSelecionado(p.id)} className="w-4 h-4 accent-red-600" />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-800">{p.nome}</td>
                    <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{p.categoria}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {p.quantidade} <span className="text-gray-400 text-xs">{p.unidade}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-400 hidden md:table-cell">
                      {p.estoque_minimo} {p.unidade}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge color={baixo ? 'red' : 'green'}>{baixo ? 'Baixo' : 'OK'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => abrirEditar(p)} className="text-blue-500 hover:text-blue-700 text-xs">Editar</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {modal && (
        <Modal title={modal === 'novo' ? 'Novo Produto' : 'Editar Produto'} onClose={fechar}>
          <div className="space-y-3">
            <div>
              <label className="label">Nome *</label>
              <input className="input" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder="Ex: Farinha de Trigo" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Categoria</label>
                <select className="input" value={form.categoria} onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))}>
                  {/* Preserva a categoria antiga do produto se não estiver na lista nova */}
                  {form.categoria && !CATEGORIAS.includes(form.categoria) && (
                    <option value={form.categoria}>{form.categoria} (antiga)</option>
                  )}
                  {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Unidade</label>
                <select
                  className="input"
                  value={form.unidade}
                  onChange={e => {
                    const nova = e.target.value
                    setForm(f => ({
                      ...f,
                      unidade: nova,
                      // Converte os valores exibidos quando a troca é entre
                      // unidades compatíveis (kg↔g, l↔ml). Senão, mantém.
                      quantidade: converterUnidade(f.quantidade, f.unidade, nova),
                      estoque_minimo: converterUnidade(f.estoque_minimo, f.unidade, nova),
                    }))
                  }}
                >
                  {UNIDADES.map(u => <option key={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Quantidade Atual</label>
                <input type="number" min="0" step="0.01" className="input" value={form.quantidade} onChange={e => setForm(f => ({ ...f, quantidade: e.target.value }))} />
              </div>
              <div>
                <label className="label">Estoque Mínimo</label>
                <input type="number" min="0" step="0.01" className="input" value={form.estoque_minimo} onChange={e => setForm(f => ({ ...f, estoque_minimo: e.target.value }))} />
              </div>
            </div>
            {modal !== 'novo' && ehProdutoDeProducao(modal.id, fichas) ? (
              <div>
                <label className="label">Custo (calculado pela ficha de produção)</label>
                <div className="input bg-gray-50 text-gray-600">
                  {formatBRL(custoUnit(modal.id))} <span className="text-xs text-gray-400">/ {form.unidade}</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">Soma dos insumos ÷ rendimento. Ajuste os preços dos insumos para alterar.</p>
              </div>
            ) : (
              <div>
                <label className="label">Preço de custo (R$ por {form.unidade})</label>
                <input type="number" min="0" step="0.01" className="input" placeholder="Ex: 4.50" value={form.preco} onChange={e => setForm(f => ({ ...f, preco: e.target.value }))} />
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={salvar} className="btn-primary flex-1">Salvar</button>
              {modal !== 'novo' && (
                <button onClick={() => excluir(modal)} className="btn-danger">Excluir</button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// Card de um produto na tela de confirmação de preços.
function PrecoCard({ grupo, onTrocar, onDesvincular, onRemoverItem, onEditarPreco, onConfirmar, onPular }) {
  const confirmado = grupo.confirmado
  const incerto = grupo.itens.some(it => it.incerto)
  const cor = confirmado
    ? 'border-green-300 bg-green-50'
    : grupo.confianca === 'media' || incerto
      ? 'border-yellow-300 bg-yellow-50'
      : 'border-gray-200 bg-white'
  const badge = confirmado ? '✓' : grupo.confianca === 'media' ? '?' : '✓'

  return (
    <div className={`border rounded-xl p-4 space-y-3 ${cor}`}>
      {/* Cabeçalho */}
      <div className="flex items-start gap-2">
        <span className={`text-lg font-bold ${confirmado ? 'text-green-600' : grupo.confianca === 'media' ? 'text-yellow-600' : 'text-gray-400'}`}>
          {badge}
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-800 leading-tight">{grupo.produtoNome}</p>
          <div className="flex items-center gap-3 mt-0.5">
            <button onClick={onTrocar} className="text-xs text-red-700 underline flex items-center gap-1">
              <ArrowLeftRight className="w-3 h-3" /> trocar produto
            </button>
            <button onClick={onDesvincular} className="text-xs text-gray-500 underline">
              desvincular
            </button>
          </div>
        </div>
        <span className="text-xs text-gray-400 shrink-0">{grupo.produtoUnidade}</span>
      </div>

      {/* Itens lidos da planilha com cálculo de normalização */}
      <ItensPrecoBreakdown itens={grupo.itens} unidade={grupo.produtoUnidade} onRemover={onRemoverItem} />

      {/* Preço médio editável */}
      <div className="flex items-center gap-2 pl-7 pt-1 border-t border-black/10">
        <label className="text-sm text-gray-600 shrink-0">
          {grupo.itens.length > 1 ? 'Média:' : 'Preço:'}
        </label>
        <span className="text-xs text-gray-400 shrink-0">R$</span>
        <input
          type="number" min="0" step="0.01" inputMode="decimal"
          value={grupo.preco}
          onChange={e => onEditarPreco(e.target.value)}
          className="input w-28 text-base font-semibold text-right"
        />
        <span className="text-sm text-gray-400 shrink-0">/ {grupo.produtoUnidade}</span>
      </div>

      {/* Ações */}
      <div className="flex gap-2 pt-1">
        <button onClick={onPular} className="btn-secondary flex-1 text-sm">Pular</button>
        <button
          onClick={onConfirmar}
          className={`flex-1 text-sm font-semibold px-4 py-2 rounded-lg transition-colors ${
            confirmado ? 'bg-green-600 text-white' : 'bg-red-800 hover:bg-red-900 text-white'
          }`}
        >
          {confirmado ? '✓ Confirmado' : 'Confirmar'}
        </button>
      </div>
    </div>
  )
}

// Detalhamento dos itens lidos da planilha com o cálculo de normalização do preço.
// Quando `onRemover` é passado e há mais de um item, mostra um × para tirar a
// marca do grupo (vira um produto novo avulso).
function ItensPrecoBreakdown({ itens, unidade, onRemover }) {
  return (
    <div className="space-y-1 pl-7">
      {itens.map(it => (
        <div key={it.id} className="flex items-start gap-2 text-xs text-gray-600 leading-relaxed">
          <div className="flex-1 min-w-0">
            <span className="text-gray-500 truncate block">{it.nomeOriginal}</span>
            {it.dividiu ? (
              <span className="font-mono">
                {formatBRL(it.precoOriginal)} ÷ {it.pesoVal} {it.pesoU} = <strong>{formatBRL(it.precoNorm)}/{unidade}</strong>
              </span>
            ) : it.incerto ? (
              <span className="text-yellow-700">
                {formatBRL(it.precoOriginal)} <span className="text-yellow-600">⚠ sem peso no nome — verifique</span>
              </span>
            ) : (
              <span className="font-mono">
                <strong>{formatBRL(it.precoNorm)}/{unidade}</strong> (direto)
              </span>
            )}
          </div>
          {onRemover && itens.length > 1 && (
            <button
              onClick={() => onRemover(it.id)}
              className="text-gray-300 hover:text-red-500 shrink-0 mt-0.5"
              aria-label="Tirar do grupo"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// Card de PRODUTO NOVO (sem vínculo no estoque) — cadastrar.
function NovoProdutoCard({
  grupo, categorias, unidades,
  onEditarNome, onEditarUnidade, onEditarCategoria, onEditarPreco, onRemoverItem,
  onVincular, onVincularLista, onConfirmar, onIgnorar,
}) {
  const confirmado = grupo.confirmado
  const cor = confirmado ? 'border-green-300 bg-green-50' : 'border-blue-200 bg-blue-50/40'

  return (
    <div className={`border rounded-xl p-4 space-y-3 ${cor}`}>
      {/* Cabeçalho */}
      <div className="flex items-start gap-2">
        <span className={`text-lg font-bold ${confirmado ? 'text-green-600' : 'text-blue-500'}`}>
          {confirmado ? '✓' : '+'}
        </span>
        <div className="flex-1 min-w-0">
          <label className="label">Nome do produto</label>
          <input
            value={grupo.nomeNovo}
            onChange={e => onEditarNome(e.target.value)}
            className="input text-sm font-medium"
            placeholder="Nome do produto"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
            <button onClick={onVincular} className="text-xs text-red-700 underline flex items-center gap-1">
              <ArrowLeftRight className="w-3 h-3" /> vincular a produto existente
            </button>
            {onVincularLista && (
              <button onClick={onVincularLista} className="text-xs text-blue-700 underline flex items-center gap-1">
                <ArrowLeftRight className="w-3 h-3" /> vincular com outro da lista
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Unidade + Categoria */}
      <div className="grid grid-cols-2 gap-2 pl-7">
        <div>
          <label className="label">Unidade</label>
          <select value={grupo.unidadeNova} onChange={e => onEditarUnidade(e.target.value)} className="input text-sm">
            {unidades.map(u => <option key={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Categoria</label>
          <select value={grupo.categoriaNova} onChange={e => onEditarCategoria(e.target.value)} className="input text-sm">
            {categorias.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* Itens lidos + cálculo */}
      <ItensPrecoBreakdown itens={grupo.itens} unidade={grupo.unidadeNova} onRemover={onRemoverItem} />

      {/* Preço editável */}
      <div className="flex items-center gap-2 pl-7 pt-1 border-t border-black/10">
        <label className="text-sm text-gray-600 shrink-0">
          {grupo.itens.length > 1 ? 'Média:' : 'Preço:'}
        </label>
        <span className="text-xs text-gray-400 shrink-0">R$</span>
        <input
          type="number" min="0" step="0.01" inputMode="decimal"
          value={grupo.preco}
          onChange={e => onEditarPreco(e.target.value)}
          className="input w-28 text-base font-semibold text-right"
        />
        <span className="text-sm text-gray-400 shrink-0">/ {grupo.unidadeNova}</span>
      </div>

      {/* Ações */}
      <div className="flex gap-2 pt-1">
        <button onClick={onIgnorar} className="btn-secondary flex-1 text-sm">Ignorar</button>
        <button
          onClick={onConfirmar}
          className={`flex-1 text-sm font-semibold px-4 py-2 rounded-lg transition-colors ${
            confirmado ? 'bg-green-600 text-white' : 'bg-red-800 hover:bg-red-900 text-white'
          }`}
        >
          {confirmado ? '✓ Vai cadastrar' : '+ Cadastrar'}
        </button>
      </div>
    </div>
  )
}
