import { useState } from 'react'
import { useFichas, useProdutos, useFichaIngredientes } from '../hooks/useEstoque'
import { db } from '../db'
import { Modal } from '../components/Modal'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

const CATEGORIAS = ['Pizza', 'Massa', 'Molho', 'Sobremesa', 'Bebida', 'Outros']
const VAZIO = { nome: '', categoria: 'Pizza', descricao: '' }

export function FichasTecnicas() {
  const fichas = useFichas()
  const [modal, setModal] = useState(null)
  const [detalhe, setDetalhe] = useState(null)
  const [form, setForm] = useState(VAZIO)
  const [busca, setBusca] = useState('')

  const filtradas = fichas.filter(f => f.nome.toLowerCase().includes(busca.toLowerCase()))

  function abrirNovo() { setForm(VAZIO); setModal('novo') }
  function abrirEditar(f) { setForm({ ...f }); setModal(f) }
  function fechar() { setModal(null) }

  async function salvar() {
    if (!form.nome.trim()) return toast.error('Nome obrigatório')
    const data = { nome: form.nome.trim(), categoria: form.categoria, descricao: form.descricao || '' }
    if (modal === 'novo') {
      const id = await db.fichasTecnicas.add(data)
      toast.success('Ficha criada!')
      setDetalhe({ ...data, id })
    } else {
      await db.fichasTecnicas.update(modal.id, data)
      toast.success('Ficha atualizada!')
    }
    fechar()
  }

  async function excluir(id) {
    if (!confirm('Excluir esta ficha?')) return
    await db.fichaIngredientes.where('fichaId').equals(id).delete()
    await db.fichasTecnicas.delete(id)
    toast.success('Ficha excluída')
    fechar()
    if (detalhe?.id === id) setDetalhe(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">Fichas Técnicas</h1>
        <button onClick={abrirNovo} className="btn-primary text-sm">+ Nova Ficha</button>
      </div>

      <input
        placeholder="Buscar ficha..."
        value={busca}
        onChange={e => setBusca(e.target.value)}
        className="input w-full"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtradas.map(f => (
          <div
            key={f.id}
            onClick={() => setDetalhe(f)}
            className={`bg-white border rounded-xl p-4 cursor-pointer hover:shadow-md transition-shadow ${detalhe?.id === f.id ? 'border-red-400 ring-1 ring-red-300' : 'border-gray-200'}`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold text-gray-800">{f.nome}</p>
                {f.descricao && <p className="text-xs text-gray-400 mt-1 line-clamp-2">{f.descricao}</p>}
              </div>
              <Badge color="orange">{f.categoria}</Badge>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={e => { e.stopPropagation(); abrirEditar(f) }} className="text-xs text-blue-500 hover:text-blue-700">Editar</button>
              <button onClick={e => { e.stopPropagation(); excluir(f.id) }} className="text-xs text-red-500 hover:text-red-700">Excluir</button>
            </div>
          </div>
        ))}
        {filtradas.length === 0 && (
          <p className="text-gray-400 text-sm col-span-full text-center py-8">Nenhuma ficha encontrada.</p>
        )}
      </div>

      {detalhe && <DetalheIngredientes ficha={detalhe} />}

      {modal && (
        <Modal title={modal === 'novo' ? 'Nova Ficha Técnica' : 'Editar Ficha'} onClose={fechar}>
          <div className="space-y-3">
            <div>
              <label className="label">Nome *</label>
              <input className="input" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder="Ex: Pizza Margherita" />
            </div>
            <div>
              <label className="label">Categoria</label>
              <select className="input" value={form.categoria} onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))}>
                {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Descrição</label>
              <textarea className="input resize-none" rows={3} value={form.descricao} onChange={e => setForm(f => ({ ...f, descricao: e.target.value }))} placeholder="Descrição opcional..." />
            </div>
            <button onClick={salvar} className="btn-primary w-full">Salvar</button>
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

  async function adicionar() {
    if (!form.produtoId || !form.quantidade) return toast.error('Preencha produto e quantidade')
    const existe = ingredientes.find(i => i.produtoId === parseInt(form.produtoId))
    if (existe) return toast.error('Ingrediente já adicionado')
    await db.fichaIngredientes.add({
      fichaId: ficha.id,
      produtoId: parseInt(form.produtoId),
      quantidade: parseFloat(form.quantidade),
    })
    setForm({ produtoId: '', quantidade: '' })
    toast.success('Ingrediente adicionado!')
  }

  async function remover(id) {
    await db.fichaIngredientes.delete(id)
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <h2 className="font-semibold text-gray-800 mb-4">
        Ingredientes — <span className="text-red-600">{ficha.nome}</span>
      </h2>

      <div className="flex gap-2 mb-4 flex-wrap">
        <select
          className="input flex-1 min-w-40"
          value={form.produtoId}
          onChange={e => setForm(f => ({ ...f, produtoId: e.target.value }))}
        >
          <option value="">Selecionar produto...</option>
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
        <p className="text-gray-400 text-sm">Nenhum ingrediente cadastrado ainda.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-3 py-2">Ingrediente</th>
              <th className="text-right px-3 py-2">Qtd</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {ingredientes.map(ing => {
              const prod = produtos.find(p => p.id === ing.produtoId)
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
