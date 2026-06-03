import { useState, useEffect } from 'react'
import { useProdutos } from '../hooks/useEstoque'
import { useAuth } from '../contexts/AuthContext'
import { registrarAjuste } from '../services/estoque'
import { ClipboardCheck, Search } from 'lucide-react'
import toast from 'react-hot-toast'

export function ContagemEstoque() {
  const produtos = useProdutos()
  const { organizacaoId } = useAuth()
  const chaveStorage = `contagem_${organizacaoId || 'x'}`

  // Mapa produtoId -> valor digitado (string). Só conta o que foi digitado.
  // Inicializa retomando o progresso salvo (se houver).
  const [contagens, setContagens] = useState(() => {
    try {
      const salvo = localStorage.getItem(`contagem_${organizacaoId || 'x'}`)
      return salvo ? JSON.parse(salvo) : {}
    } catch { return {} }
  })
  const [busca, setBusca] = useState('')
  const [soNaoContados, setSoNaoContados] = useState(false)
  const [aplicando, setAplicando] = useState(false)

  // Salvar progresso a cada mudança
  useEffect(() => {
    try {
      if (Object.keys(contagens).length > 0) localStorage.setItem(chaveStorage, JSON.stringify(contagens))
      else localStorage.removeItem(chaveStorage)
    } catch { /* ignora */ }
  }, [contagens, chaveStorage])

  function setValor(id, valor) {
    setContagens(prev => ({ ...prev, [id]: valor }))
  }

  function foiContado(id) {
    return contagens[id] !== undefined && String(contagens[id]).trim() !== ''
  }

  function deltaDe(p) {
    if (!foiContado(p.id)) return null
    const contado = parseFloat(String(contagens[p.id]).replace(',', '.'))
    if (isNaN(contado)) return null
    return Math.round((contado - (p.quantidade || 0)) * 1000) / 1000
  }

  const filtrados = produtos.filter(p => {
    const okBusca = !busca || p.nome.toLowerCase().includes(busca.toLowerCase())
    const okContado = !soNaoContados || !foiContado(p.id)
    return okBusca && okContado
  })

  // Resumo (sobre todos os produtos, não só os filtrados)
  const contadosIds = produtos.filter(p => foiContado(p.id))
  const comDelta = contadosIds.map(p => ({ p, d: deltaDe(p) })).filter(x => x.d !== null && x.d !== 0)
  const sobra = comDelta.filter(x => x.d > 0).length
  const falta = comDelta.filter(x => x.d < 0).length

  async function aplicar() {
    if (comDelta.length === 0) return toast.error('Nenhuma diferença para aplicar')
    if (!confirm(`Aplicar a contagem? ${comDelta.length} produto(s) terão o estoque ajustado.`)) return

    setAplicando(true)
    let ok = 0, erros = 0
    const aplicados = []
    for (const { p } of comDelta) {
      try {
        const contado = parseFloat(String(contagens[p.id]).replace(',', '.'))
        await registrarAjuste(p.id, contado, 'Contagem de estoque')
        aplicados.push(p.id)
        ok++
      } catch { erros++ }
    }
    setAplicando(false)

    // Remove dos contagens os que foram aplicados
    setContagens(prev => {
      const novo = { ...prev }
      aplicados.forEach(id => delete novo[id])
      return novo
    })

    if (ok > 0) toast.success(`${ok} produto(s) ajustado(s)!`)
    if (erros > 0) toast.error(`${erros} produto(s) não puderam ser ajustados`)
  }

  function limparTudo() {
    if (!confirm('Limpar toda a contagem em andamento?')) return
    setContagens({})
  }

  const totalContados = contadosIds.length

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <ClipboardCheck className="w-6 h-6 text-red-800" /> Contagem
        </h1>
        {totalContados > 0 && (
          <button onClick={limparTudo} className="text-xs text-gray-500 underline">Limpar</button>
        )}
      </div>

      <p className="text-sm text-gray-500">
        Digite a quantidade <strong>real contada</strong> de cada produto. O estoque será ajustado para o valor informado. Itens em branco não mudam.
      </p>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            placeholder="Buscar produto..."
            value={busca}
            onChange={e => setBusca(e.target.value)}
            className="input pl-9"
          />
        </div>
        <button
          onClick={() => setSoNaoContados(v => !v)}
          className={`text-xs font-medium px-3 rounded-lg border transition-colors ${
            soNaoContados ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-gray-200 text-gray-600'
          }`}
        >
          Só não contados
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
        {filtrados.length === 0 ? (
          <p className="text-gray-400 text-sm p-6 text-center">Nenhum produto encontrado.</p>
        ) : (
          filtrados.map(p => {
            const d = deltaDe(p)
            const contado = foiContado(p.id)
            return (
              <div key={p.id} className={`flex items-center gap-3 p-3 ${contado ? 'bg-gray-50' : ''}`}>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 truncate">{p.nome}</p>
                  <p className="text-xs text-gray-500">Sistema: {p.quantidade} {p.unidade}</p>
                </div>
                {d !== null && d !== 0 && (
                  <span className={`text-xs font-semibold ${d > 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {d > 0 ? '+' : ''}{d}
                  </span>
                )}
                {d === 0 && <span className="text-xs text-gray-400">ok</span>}
                <input
                  type="number" min="0" step="0.001" inputMode="decimal"
                  placeholder="contar"
                  value={contagens[p.id] ?? ''}
                  onChange={e => setValor(p.id, e.target.value)}
                  className="input w-24 text-sm text-right"
                />
                <span className="text-xs text-gray-400 w-8">{p.unidade}</span>
              </div>
            )
          })
        )}
      </div>

      {totalContados > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-3 sticky bottom-20">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">{totalContados} contado(s)</span>
            <span className="text-green-600">{sobra} sobra</span>
            <span className="text-red-600">{falta} falta</span>
          </div>
          <button
            onClick={aplicar}
            disabled={aplicando || comDelta.length === 0}
            className="btn-primary w-full disabled:opacity-50"
          >
            {aplicando ? 'Aplicando...' : `Aplicar contagem (${comDelta.length} ajuste(s))`}
          </button>
        </div>
      )}
    </div>
  )
}
