import { useState, useRef } from 'react'
import { useProdutos } from '../hooks/useEstoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { importarProdutosCSV, exportarEstoqueCSV, exportarEstoquePDF } from '../services/importExport'
import { fatorUnidade, converterUnidade } from '../lib/unidades'
import { Modal } from '../components/Modal'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

const CATEGORIAS = ['Massa', 'Molho', 'Queijo', 'Embutido', 'Vegetal', 'Tempero', 'Bebida', 'Embalagem', 'Outros']
const UNIDADES = ['kg', 'g', 'L', 'ml', 'un', 'cx', 'pct', 'fardo']
const VAZIO = { nome: '', categoria: 'Outros', unidade: 'kg', quantidade: 0, estoque_minimo: 0 }

export function Estoque() {
  const produtos = useProdutos()
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(VAZIO)
  const [busca, setBusca] = useState('')
  const [filtroCategoria, setFiltroCategoria] = useState('')
  const [selecionados, setSelecionados] = useState(new Set())
  const fileRef = useRef()

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
    const { error } = await supabase.from('produtos').delete().in('id', [...selecionados])
    if (error) return toast.error('Erro ao excluir')
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
    }
    if (modal === 'novo') {
      const { error } = await supabase.from('produtos').insert({ ...data, organizacao_id: session.organizacaoId })
      if (error) return toast.error(error.message)
      toast.success('Produto adicionado!')
    } else {
      const { error } = await supabase.from('produtos').update(data).eq('id', modal.id)
      if (error) return toast.error(error.message)

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

  async function excluir(id) {
    if (!confirm('Excluir este produto?')) return
    await supabase.from('produtos').delete().eq('id', id)
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-800">Estoque</h1>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => fileRef.current.click()} className="btn-secondary text-sm">📥 Importar CSV</button>
          <button onClick={() => exportarEstoqueCSV(filtrados)} className="btn-secondary text-sm">📤 CSV</button>
          <button onClick={() => exportarEstoquePDF(filtrados)} className="btn-secondary text-sm">📄 PDF</button>
          <button onClick={abrirNovo} className="btn-primary text-sm">+ Novo Produto</button>
        </div>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={importar} />
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
            <div className="flex gap-2 pt-2">
              <button onClick={salvar} className="btn-primary flex-1">Salvar</button>
              {modal !== 'novo' && (
                <button onClick={() => excluir(modal.id)} className="btn-danger">Excluir</button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
