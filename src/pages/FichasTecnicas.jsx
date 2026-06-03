import { useState, useRef } from 'react'
import { useFichas, useProdutos, useFichaIngredientes } from '../hooks/useEstoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { analisarFichaTecnica, prepararImagem } from '../services/geminiVision'
import { registrarProducao } from '../services/estoque'
import { Modal } from '../components/Modal'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

const CATEGORIAS = ['Pizza', 'Massa', 'Molho', 'Sobremesa', 'Bebida', 'Outros']
const VAZIO_PRATO = { nome: '', categoria: 'Pizza', descricao: '', tipo_ficha: 'prato' }
const VAZIO_PRODUCAO = { nome: '', descricao: '', tipo_ficha: 'producao', produto_saida_id: '', rendimento: '' }

export function FichasTecnicas() {
  const fichas = useFichas()
  const produtos = useProdutos()
  const [aba, setAba] = useState('prato') // 'prato' | 'producao'
  const [modal, setModal] = useState(null)
  const [detalhe, setDetalhe] = useState(null)
  const [form, setForm] = useState(VAZIO_PRATO)
  const [busca, setBusca] = useState('')
  const [modalFoto, setModalFoto] = useState(false)
  const [fotoAnalise, setFotoAnalise] = useState(null)
  const [analisando, setAnalisando] = useState(false)
  const [resultadoFoto, setResultadoFoto] = useState(null)
  const fileRefFoto = useRef()
  const cameraRefFoto = useRef()

  const apiKey = localStorage.getItem('gemini_api_key') || ''
  const ehProducao = aba === 'producao'

  async function analisarFoto(e) {
    const file = e.target.files[0]
    if (!file) return
    setFotoAnalise({ url: URL.createObjectURL(file), file })
    setResultadoFoto(null)
    e.target.value = ''
  }

  async function processarFoto() {
    if (!fotoAnalise) return
    if (!apiKey) return toast.error('Configure a chave da API na aba 📷 Foto IA primeiro')
    setAnalisando(true)
    try {
      const { base64, mimeType } = await prepararImagem(fotoAnalise.file)
      const res = await analisarFichaTecnica(base64, mimeType, produtos, apiKey)
      setResultadoFoto(res)
    } catch (e) {
      toast.error(e.message || 'Erro ao analisar imagem')
    } finally {
      setAnalisando(false)
    }
  }

  async function salvarFichaFoto() {
    if (!resultadoFoto) return
    const orgId = session.organizacaoId

    const { data: ficha, error } = await supabase
      .from('fichas_tecnicas')
      .insert({
        organizacao_id: orgId,
        nome: resultadoFoto.nome,
        categoria: resultadoFoto.categoria || 'Pizza',
        descricao: resultadoFoto.descricao || '',
        tipo_ficha: 'prato',
      })
      .select()
      .single()
    if (error) return toast.error(error.message)

    for (const ing of resultadoFoto.ingredientes) {
      const busca = (ing.nomeCadastrado || ing.nome || '').toLowerCase()
      let prod = produtos.find(p => p.nome.toLowerCase() === busca)
      if (!prod) prod = produtos.find(p => p.nome.toLowerCase().includes(busca) || busca.includes(p.nome.toLowerCase()))
      let produtoId = prod?.id

      if (!produtoId) {
        const { data: novo } = await supabase
          .from('produtos')
          .insert({ organizacao_id: orgId, nome: ing.nome, categoria: 'Outros', unidade: ing.unidade || 'un', quantidade: 0, estoque_minimo: 0 })
          .select()
          .single()
        produtoId = novo?.id
      }
      if (produtoId) {
        await supabase.from('ficha_ingredientes').insert({ ficha_id: ficha.id, produto_id: produtoId, quantidade: ing.quantidade })
      }
    }
    toast.success(`Ficha "${resultadoFoto.nome}" criada com ${resultadoFoto.ingredientes.length} ingrediente(s)!`)
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
    setForm({ ...f, produto_saida_id: f.produto_saida_id ?? '', rendimento: f.rendimento ?? '' })
    setModal(f)
  }
  function fechar() { setModal(null) }

  async function salvar() {
    if (!form.nome.trim()) return toast.error('Nome obrigatório')
    const tipo = form.tipo_ficha || 'prato'
    let data
    if (tipo === 'producao') {
      if (!form.produto_saida_id) return toast.error('Selecione o produto gerado')
      if (!form.rendimento || parseFloat(form.rendimento) <= 0) return toast.error('Informe o rendimento (maior que zero)')
      data = {
        nome: form.nome.trim(),
        categoria: 'Produção',
        descricao: form.descricao || '',
        tipo_ficha: 'producao',
        produto_saida_id: parseInt(form.produto_saida_id),
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
      toast.success('Ficha criada!')
      setDetalhe({ ...data, id: ficha.id })
    } else {
      const { error } = await supabase.from('fichas_tecnicas').update(data).eq('id', modal.id)
      if (error) return toast.error(error.message)
      toast.success('Ficha atualizada!')
      setDetalhe(d => (d?.id === modal.id ? { ...d, ...data } : d))
    }
    fechar()
  }

  async function excluir(id) {
    if (!confirm('Excluir esta ficha?')) return
    await supabase.from('ficha_ingredientes').delete().eq('ficha_id', id)
    await supabase.from('fichas_tecnicas').delete().eq('id', id)
    toast.success('Ficha excluída')
    fechar()
    if (detalhe?.id === id) setDetalhe(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">Fichas Técnicas</h1>
        <div className="flex gap-2">
          {!ehProducao && (
            <button onClick={() => setModalFoto(true)} className="btn-secondary text-sm">📷 Importar por Foto</button>
          )}
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
                    ? <p className="text-xs text-gray-500 mt-1">Gera: {prodGerado?.nome || '—'}{f.rendimento ? ` (${f.rendimento} ${prodGerado?.unidade || ''}/lote)` : ''}</p>
                    : (f.descricao && <p className="text-xs text-gray-400 mt-1 line-clamp-2">{f.descricao}</p>)
                  }
                </div>
                <Badge color={f.tipo_ficha === 'producao' ? 'blue' : 'orange'}>
                  {f.tipo_ficha === 'producao' ? 'Produção' : f.categoria}
                </Badge>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={e => { e.stopPropagation(); abrirEditar(f) }} className="text-xs text-blue-500 hover:text-blue-700">Editar</button>
                <button onClick={e => { e.stopPropagation(); excluir(f.id) }} className="text-xs text-red-500 hover:text-red-700">Excluir</button>
              </div>
            </div>
          )
        })}
        {filtradas.length === 0 && (
          <p className="text-gray-400 text-sm col-span-full text-center py-8">Nenhuma ficha encontrada.</p>
        )}
      </div>

      {detalhe && <DetalheIngredientes ficha={detalhe} />}

      {modal && (
        <Modal title={modal === 'novo' ? (form.tipo_ficha === 'producao' ? 'Nova Ficha de Produção' : 'Nova Ficha de Prato') : 'Editar Ficha'} onClose={fechar}>
          <div className="space-y-3">
            <div>
              <label className="label">Nome *</label>
              <input className="input" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder={form.tipo_ficha === 'producao' ? 'Ex: Massa de Pizza' : 'Ex: Pizza Margherita'} />
            </div>

            {form.tipo_ficha === 'producao' ? (
              <>
                <div>
                  <label className="label">Produto gerado *</label>
                  <select className="input" value={form.produto_saida_id} onChange={e => setForm(f => ({ ...f, produto_saida_id: e.target.value }))}>
                    <option value="">Selecionar produto...</option>
                    {produtos.map(p => <option key={p.id} value={p.id}>{p.nome} ({p.unidade})</option>)}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">O produto que será adicionado ao estoque ao produzir.</p>
                </div>
                <div>
                  <label className="label">Rendimento por lote *</label>
                  <input type="number" min="0.001" step="0.001" className="input" value={form.rendimento} onChange={e => setForm(f => ({ ...f, rendimento: e.target.value }))} placeholder="Ex: 10 (unidades por produção)" />
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
        <Modal title="Importar Ficha por Foto" onClose={() => { setModalFoto(false); setFotoAnalise(null); setResultadoFoto(null) }}>
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
              <input ref={fileRefFoto} type="file" accept="image/*" className="hidden" onChange={analisarFoto} />
              <input ref={cameraRefFoto} type="file" accept="image/*" capture="environment" className="hidden" onChange={analisarFoto} />
            </div>

            {fotoAnalise && !resultadoFoto && (
              <button onClick={processarFoto} disabled={analisando} className="btn-primary w-full disabled:opacity-50">
                {analisando ? 'Analisando...' : '🔍 Analisar com IA'}
              </button>
            )}

            {resultadoFoto && (
              <div className="space-y-3">
                <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                  <p className="font-semibold text-gray-800">{resultadoFoto.nome}</p>
                  <p className="text-xs text-gray-500">{resultadoFoto.descricao}</p>
                  {resultadoFoto.observacao && <p className="text-xs text-yellow-700">⚠️ {resultadoFoto.observacao}</p>}
                </div>
                <p className="text-xs font-medium text-gray-500 uppercase">Ingredientes identificados</p>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {resultadoFoto.ingredientes.map((ing, i) => {
                    const prod = produtos.find(p => p.nome.toLowerCase() === (ing.nomeCadastrado || '').toLowerCase())
                    return (
                      <div key={i} className="flex items-center justify-between text-sm border border-gray-100 rounded px-3 py-1.5">
                        <span className="text-gray-700">{ing.nome}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{ing.quantidade} {ing.unidade}</span>
                          {prod ? <Badge color="green">✓</Badge> : <Badge color="gray">Novo</Badge>}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <button onClick={salvarFichaFoto} className="btn-primary w-full">
                  ✅ Criar Ficha com {resultadoFoto.ingredientes.length} ingrediente(s)
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

function DetalheIngredientes({ ficha }) {
  const produtos = useProdutos()
  const ingredientes = useFichaIngredientes(ficha.id)
  const [form, setForm] = useState({ produtoId: '', quantidade: '' })
  const [lotes, setLotes] = useState('')
  const [produzindo, setProduzindo] = useState(false)

  const ehProducao = ficha.tipo_ficha === 'producao'
  const prodGerado = produtos.find(p => p.id === ficha.produto_saida_id)

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
      toast.error(e.message || 'Erro ao produzir')
    } finally {
      setProduzindo(false)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <h2 className="font-semibold text-gray-800 mb-4">
        {ehProducao ? 'Insumos' : 'Ingredientes'} — <span className="text-red-600">{ficha.nome}</span>
      </h2>

      {ehProducao && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
          <p className="text-sm text-gray-700">
            Gera <strong>{prodGerado?.nome || '—'}</strong>
            {ficha.rendimento ? <> — rende <strong>{ficha.rendimento} {prodGerado?.unidade || ''}</strong> por lote</> : ' — defina o rendimento'}
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
        <select
          className="input flex-1 min-w-40"
          value={form.produtoId}
          onChange={e => setForm(f => ({ ...f, produtoId: e.target.value }))}
        >
          <option value="">Selecionar {ehProducao ? 'insumo' : 'produto'}...</option>
          {produtos.map(p => <option key={p.id} value={p.id}>{p.nome} ({p.unidade})</option>)}
        </select>
        <input
          type="number" min="0.001" step="0.001"
          placeholder="Quantidade"
          className="input w-32"
          value={form.quantidade}
          onChange={e => setForm(f => ({ ...f, quantidade: e.target.value }))}
        />
        <button onClick={adicionar} className="btn-primary">Adicionar</button>
      </div>

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
