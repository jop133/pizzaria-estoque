import { useState } from 'react'
import { useProdutos, useFichas, useFichaIngredientes } from '../hooks/useEstoque'
import { registrarSaidaFicha, registrarSaidaManual, registrarEntrada } from '../services/estoque'
import { SeletorProduto } from '../components/SeletorProduto'
import { Modal } from '../components/Modal'
import toast from 'react-hot-toast'

const TIPOS = [
  { value: 'saida_ficha', label: '🍕 Saída por Ficha (venda)', color: 'bg-orange-50 border-orange-200' },
  { value: 'saida_manual', label: '📦 Saída Manual (descarte/uso)', color: 'bg-red-50 border-red-200' },
  { value: 'entrada', label: '✅ Entrada (reposição/compra)', color: 'bg-green-50 border-green-200' },
]

export function Lancamentos() {
  const produtos = useProdutos()
  const todasFichas = useFichas()
  // Apenas fichas de prato podem ser vendidas (produção não é venda)
  const fichas = todasFichas.filter(f => (f.tipo_ficha || 'prato') === 'prato')
  const [tipo, setTipo] = useState('saida_ficha')
  const [form, setForm] = useState({ fichaId: '', produtoId: '', quantidade: '', observacao: '', marca: '' })
  const [loading, setLoading] = useState(false)
  const [pickerAberto, setPickerAberto] = useState(false)
  const [avisoCru, setAvisoCru] = useState(null) // insumos que vão cair no cru (reserva OU)

  const fichaSel = fichas.find(f => f.id === parseInt(form.fichaId))
  const produtoSel = produtos.find(p => p.id === parseInt(form.produtoId))
  const ingredientesFicha = useFichaIngredientes(form.fichaId)

  // Insumos com reserva (OU) que vão cair no cru por faltar o porcionado.
  function planejarFallback(qtd) {
    return ingredientesFicha.filter(i => i.produto_alt_id).map(i => {
      const prim = produtos.find(p => p.id === i.produto_id)
      const precisa = (i.quantidade || 0) * qtd
      if ((prim?.quantidade || 0) < precisa) {
        const alt = produtos.find(p => p.id === i.produto_alt_id)
        return {
          primNome: prim?.nome || 'Porcionado', tem: prim?.quantidade || 0, primUn: prim?.unidade || '',
          precisa, altNome: alt?.nome || 'Cru', altQtd: (i.quantidade_alt || 0) * qtd, altUn: alt?.unidade || '',
        }
      }
      return null
    }).filter(Boolean)
  }

  async function lancar() {
    const qtd = parseFloat(form.quantidade)
    if (!qtd || qtd <= 0) return toast.error('Quantidade deve ser maior que zero')
    if (tipo === 'saida_ficha' && !form.fichaId) return toast.error('Selecione a ficha técnica')
    if (tipo !== 'saida_ficha' && !form.produtoId) return toast.error('Selecione o produto')

    // Venda: se algum insumo com reserva vai usar o cru, avisa antes.
    if (tipo === 'saida_ficha') {
      const fallback = planejarFallback(qtd)
      if (fallback.length > 0) { setAvisoCru(fallback); return }
    }
    await executarLancamento(qtd)
  }

  async function executarLancamento(qtd) {
    setAvisoCru(null)
    setLoading(true)
    try {
      if (tipo === 'saida_ficha') {
        await registrarSaidaFicha(parseInt(form.fichaId), qtd, form.observacao)
        toast.success('Saída lançada! Estoque atualizado.')
      } else if (tipo === 'saida_manual') {
        await registrarSaidaManual(parseInt(form.produtoId), qtd, form.observacao)
        toast.success('Saída manual lançada!')
      } else {
        await registrarEntrada(parseInt(form.produtoId), qtd, form.observacao, form.marca)
        toast.success('Entrada registrada! Estoque atualizado.')
      }
      setForm({ fichaId: '', produtoId: '', quantidade: '', observacao: '', marca: '' })
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
            onClick={() => { setTipo(t.value); setForm({ fichaId: '', produtoId: '', quantidade: '', observacao: '', marca: '' }) }}
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
            <button
              onClick={() => setPickerAberto(true)}
              className={`input text-left ${fichaSel ? 'text-gray-800' : 'text-gray-400'}`}
            >
              {fichaSel ? fichaSel.nome : 'Selecionar ficha...'}
            </button>
            {fichas.length === 0 && (
              <p className="text-xs text-orange-600 mt-1">Crie fichas técnicas na aba correspondente primeiro.</p>
            )}
          </div>
        ) : (
          <div>
            <label className="label">Produto</label>
            <button
              onClick={() => setPickerAberto(true)}
              className={`input text-left ${produtoSel ? 'text-gray-800' : 'text-gray-400'}`}
            >
              {produtoSel ? `${produtoSel.nome} — ${produtoSel.quantidade} ${produtoSel.unidade} em estoque` : 'Selecionar produto...'}
            </button>
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

        {tipo === 'entrada' && (
          <div>
            <label className="label">Marca (opcional)</label>
            <input
              className="input"
              placeholder="Ex: Tio João, Italac, Forno de Minas..."
              value={form.marca}
              onChange={e => setForm(f => ({ ...f, marca: e.target.value }))}
            />
          </div>
        )}

        <div>
          <label className="label">Observação (opcional)</label>
          <input
            className="input"
            placeholder="Ex: mesa 5, turno da tarde..."
            value={form.observacao}
            onChange={e => setForm(f => ({ ...f, observacao: e.target.value }))}
          />
        </div>

        <button onClick={lancar} disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'Processando...' : 'Confirmar Lançamento'}
        </button>
      </div>

      {pickerAberto && (
        tipo === 'saida_ficha' ? (
          <SeletorProduto
            titulo="Selecionar ficha"
            produtos={fichas}
            descricao={() => ''}
            onEscolher={f => { setForm(x => ({ ...x, fichaId: String(f.id) })); setPickerAberto(false) }}
            onClose={() => setPickerAberto(false)}
          />
        ) : (
          <SeletorProduto
            titulo="Selecionar produto"
            produtos={produtos}
            descricao={p => `${p.quantidade} ${p.unidade} em estoque`}
            onEscolher={p => { setForm(x => ({ ...x, produtoId: String(p.id) })); setPickerAberto(false) }}
            onClose={() => setPickerAberto(false)}
          />
        )
      )}

      {avisoCru && (
        <Modal title="Atenção — vai usar o cru" onClose={() => setAvisoCru(null)}>
          <div className="space-y-4">
            <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <span className="text-amber-600">⚠️</span>
              <p className="text-sm text-amber-800">Não há <strong>porcionado</strong> suficiente. Estes serão consumidos do <strong>cru</strong>:</p>
            </div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {avisoCru.map((a, i) => (
                <div key={i} className="text-sm border-b border-gray-100 py-1.5">
                  <p className="text-gray-700"><strong>{a.primNome}</strong> — tem {a.tem} {a.primUn}, precisa {a.precisa} {a.primUn}</p>
                  <p className="text-xs text-amber-700">→ usará {a.altQtd} {a.altUn} de {a.altNome}</p>
                </div>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setAvisoCru(null)} className="btn-secondary flex-1">Voltar</button>
              <button onClick={() => executarLancamento(parseFloat(form.quantidade))} disabled={loading} className="btn-primary flex-1">Lançar mesmo assim</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
