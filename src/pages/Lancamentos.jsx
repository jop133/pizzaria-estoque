import { useState, useRef } from 'react'
import { useProdutos, useFichas } from '../hooks/useEstoque'
import { registrarSaidaFicha, registrarSaidaManual, registrarEntrada } from '../services/estoque'
import { analisarImagemEstoque, prepararImagem } from '../services/geminiVision'
import toast from 'react-hot-toast'

const TIPOS = [
  { value: 'saida_ficha', label: '🍕 Saída por Ficha (venda)', color: 'bg-orange-50 border-orange-200' },
  { value: 'saida_manual', label: '📦 Saída Manual (descarte/uso)', color: 'bg-rose-50 border-rose-200' },
  { value: 'entrada', label: '✅ Entrada (reposição/compra)', color: 'bg-green-50 border-green-200' },
]

export function Lancamentos() {
  const produtos = useProdutos()
  const fichas = useFichas()
  const [tipo, setTipo] = useState('saida_ficha')
  const [form, setForm] = useState({ fichaId: '', produtoId: '', quantidade: '', observacao: '', marca: '' })
  const [loading, setLoading] = useState(false)
  const [analisandoFoto, setAnalisandoFoto] = useState(false)
  const [previewFoto, setPreviewFoto] = useState(null)
  const fileRef = useRef()
  const cameraRef = useRef()

  const apiKey = localStorage.getItem('gemini_api_key') || ''

  async function selecionarFoto(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    if (!apiKey) return toast.error('Configure a chave da API na aba 📷 Foto IA primeiro')

    setPreviewFoto(URL.createObjectURL(file))
    setAnalisandoFoto(true)
    try {
      const { base64, mimeType } = await prepararImagem(file)
      const res = await analisarImagemEstoque(base64, mimeType, produtos, fichas, apiKey)

      // Selecionar tipo baseado no resultado da IA
      if (res.tipo && res.tipo !== 'desconhecido') setTipo(res.tipo)

      // Preencher o primeiro item identificado
      const item = res.itens?.[0]
      if (item) {
        const qtd = item.quantidade || ''
        const busca = (item.nomeCadastrado || item.nome || '').toLowerCase()

        if (res.tipo === 'saida_ficha') {
          const ficha = fichas.find(f => f.nome.toLowerCase() === busca)
            || fichas.find(f => f.nome.toLowerCase().includes(busca) || busca.includes(f.nome.toLowerCase()))
          setForm(f => ({ ...f, quantidade: String(qtd), fichaId: ficha ? String(ficha.id) : '' }))
          if (!ficha && item.nome) toast(`Ficha "${item.nome}" não encontrada — selecione manualmente`, { icon: '⚠️' })
        } else {
          const prod = produtos.find(p => p.nome.toLowerCase() === busca)
            || produtos.find(p => p.nome.toLowerCase().includes(busca) || busca.includes(p.nome.toLowerCase()))
          setForm(f => ({ ...f, quantidade: String(qtd), produtoId: prod ? String(prod.id) : '', marca: item.marca || '' }))
          if (!prod && item.nome) toast(`Produto "${item.nome}" não encontrado — selecione manualmente`, { icon: '⚠️' })
        }

        if (res.itens.length > 1) {
          toast(`${res.itens.length} itens identificados. Use a aba 📷 Foto IA para lançar todos de uma vez.`, { icon: 'ℹ️', duration: 5000 })
        }
      }

      toast.success(`Foto analisada: ${res.descricao || 'itens identificados'}`)
    } catch (e) {
      toast.error(e.message || 'Erro ao analisar foto')
    } finally {
      setAnalisandoFoto(false)
    }
  }

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
        await registrarEntrada(parseInt(form.produtoId), qtd, form.observacao, form.marca)
        toast.success('Entrada registrada! Estoque atualizado.')
      }
      setForm({ fichaId: '', produtoId: '', quantidade: '', observacao: '', marca: '' })
      setPreviewFoto(null)
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
            onClick={() => { setTipo(t.value); setForm({ fichaId: '', produtoId: '', quantidade: '', observacao: '' }); setPreviewFoto(null) }}
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
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-700">{currentTipo.label}</h2>
          <button
            onClick={() => fileRef.current.click()}
            disabled={analisandoFoto}
            className="flex items-center gap-1.5 text-xs font-medium bg-white border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
          >
            {analisandoFoto ? (
              <>
                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Analisando...
              </>
            ) : '📷 Preencher por foto'}
          </button>
        </div>

        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={selecionarFoto} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={selecionarFoto} />

        {previewFoto && (
          <div className="flex items-center gap-3 bg-gray-50 rounded-lg p-2">
            <img src={previewFoto} alt="" className="w-12 h-12 object-cover rounded" />
            <p className="text-xs text-gray-500 flex-1">Foto analisada — confira e ajuste os campos abaixo</p>
            <button onClick={() => setPreviewFoto(null)} className="text-gray-300 hover:text-gray-500">✕</button>
          </div>
        )}

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
    </div>
  )
}
