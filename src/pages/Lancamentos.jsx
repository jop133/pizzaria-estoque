import { useState } from 'react'
import { useProdutos, useFichas } from '../hooks/useEstoque'
import { registrarSaidaFicha, registrarSaidaManual, registrarEntrada } from '../services/estoque'
import toast from 'react-hot-toast'

const TIPOS = [
  { value: 'saida_ficha', label: '🍕 Saída por Ficha (venda)', color: 'bg-orange-50 border-orange-200' },
  { value: 'saida_manual', label: '📦 Saída Manual (descarte/uso)', color: 'bg-red-50 border-red-200' },
  { value: 'entrada', label: '✅ Entrada (reposição/compra)', color: 'bg-green-50 border-green-200' },
]

export function Lancamentos() {
  const produtos = useProdutos()
  const fichas = useFichas()
  const [tipo, setTipo] = useState('saida_ficha')
  const [form, setForm] = useState({ fichaId: '', produtoId: '', quantidade: '', observacao: '' })
  const [loading, setLoading] = useState(false)

  async function lancar() {
    const qtd = parseFloat(form.quantidade)
    if (!qtd || qtd <= 0) return toast.error('Quantidade deve ser maior que zero')

    setLoading(true)
    try {
      if (tipo === 'saida_ficha') {
        if (!form.fichaId) return toast.error('Selecione a ficha técnica')
        await registrarSaidaFicha(parseInt(form.fichaId), qtd, form.observacao)
        toast.success('Saída lançada! Estoque atualizado.')
      } else if (tipo === 'saida_manual') {
        if (!form.produtoId) return toast.error('Selecione o produto')
        await registrarSaidaManual(parseInt(form.produtoId), qtd, form.observacao)
        toast.success('Saída manual lançada!')
      } else {
        if (!form.produtoId) return toast.error('Selecione o produto')
        await registrarEntrada(parseInt(form.produtoId), qtd, form.observacao)
        toast.success('Entrada registrada! Estoque atualizado.')
      }
      setForm({ fichaId: '', produtoId: '', quantidade: '', observacao: '' })
    } catch (e) {
      toast.error(e.message || 'Erro ao lançar')
    } finally {
      setLoading(false)
    }
  }

  const currentTipo = TIPOS.find(t => t.value === tipo)

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-800">Lançamentos</h1>

      <div className="grid grid-cols-1 gap-2">
        {TIPOS.map(t => (
          <button
            key={t.value}
            onClick={() => setTipo(t.value)}
            className={`p-3 rounded-xl border-2 text-left font-medium text-sm transition-all ${
              tipo === t.value
                ? t.color + ' border-current ring-1 ring-current opacity-100'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={`bg-white border-2 rounded-xl p-5 space-y-4 ${currentTipo.color}`}>
        <h2 className="font-semibold text-gray-700">{currentTipo.label}</h2>

        {tipo === 'saida_ficha' ? (
          <div>
            <label className="label">Ficha Técnica (prato/pizza)</label>
            <select className="input" value={form.fichaId} onChange={e => setForm(f => ({ ...f, fichaId: e.target.value }))}>
              <option value="">Selecionar ficha...</option>
              {fichas.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
            </select>
            {fichas.length === 0 && (
              <p className="text-xs text-orange-600 mt-1">Crie fichas técnicas na aba correspondente primeiro.</p>
            )}
          </div>
        ) : (
          <div>
            <label className="label">Produto</label>
            <select className="input" value={form.produtoId} onChange={e => setForm(f => ({ ...f, produtoId: e.target.value }))}>
              <option value="">Selecionar produto...</option>
              {produtos.map(p => (
                <option key={p.id} value={p.id}>{p.nome} — {p.quantidade} {p.unidade} em estoque</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="label">
            {tipo === 'saida_ficha' ? 'Quantidade de unidades vendidas' : 'Quantidade'}
          </label>
          <input
            type="number" min="0.001" step="0.001"
            className="input"
            placeholder={tipo === 'saida_ficha' ? 'Ex: 3 (pizzas)' : 'Ex: 2.5'}
            value={form.quantidade}
            onChange={e => setForm(f => ({ ...f, quantidade: e.target.value }))}
          />
        </div>

        <div>
          <label className="label">Observação (opcional)</label>
          <input
            className="input"
            placeholder="Ex: mesa 5, turno da tarde..."
            value={form.observacao}
            onChange={e => setForm(f => ({ ...f, observacao: e.target.value }))}
          />
        </div>

        <button
          onClick={lancar}
          disabled={loading}
          className="btn-primary w-full disabled:opacity-50"
        >
          {loading ? 'Processando...' : 'Confirmar Lançamento'}
        </button>
      </div>
    </div>
  )
}
