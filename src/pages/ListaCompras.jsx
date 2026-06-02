import { useState } from 'react'
import { useProdutosAbaixoMinimo } from '../hooks/useEstoque'
import { useAuth } from '../contexts/AuthContext'
import { ShoppingCart, Check, Share2 } from 'lucide-react'
import toast from 'react-hot-toast'

export function ListaCompras() {
  const itens = useProdutosAbaixoMinimo()
  const { organizacao } = useAuth()
  const [pegos, setPegos] = useState(new Set())

  function togglePego(id) {
    setPegos(prev => {
      const novo = new Set(prev)
      novo.has(id) ? novo.delete(id) : novo.add(id)
      return novo
    })
  }

  // Quanto falta comprar para voltar ao mínimo (nunca negativo).
  function faltam(p) {
    const f = (p.estoque_minimo || 0) - (p.quantidade || 0)
    return f > 0 ? Math.round(f * 1000) / 1000 : 0
  }

  function gerarTexto() {
    const linhas = itens.map(p => `• ${p.nome} — comprar ~${faltam(p)} ${p.unidade} (tem ${p.quantidade}, mín. ${p.estoque_minimo})`)
    return `🛒 Lista de Compras${organizacao?.nome ? ' — ' + organizacao.nome : ''}\n\n${linhas.join('\n')}`
  }

  async function compartilhar() {
    if (itens.length === 0) return
    const texto = gerarTexto()
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Lista de Compras', text: texto })
      } else {
        await navigator.clipboard.writeText(texto)
        toast.success('Lista copiada! Cole no WhatsApp para enviar.')
      }
    } catch {
      // usuário cancelou o compartilhamento — ignora
    }
  }

  function abrirWhatsApp() {
    if (itens.length === 0) return
    window.open(`https://wa.me/?text=${encodeURIComponent(gerarTexto())}`, '_blank')
  }

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <ShoppingCart className="w-6 h-6 text-red-800" /> Lista de Compras
        </h1>
        {itens.length > 0 && (
          <span className="bg-red-100 text-red-800 text-sm font-bold px-2.5 py-1 rounded-full">{itens.length}</span>
        )}
      </div>

      <p className="text-sm text-gray-500">
        Itens no ou abaixo do estoque mínimo. Marque conforme for comprando.
      </p>

      {itens.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-50">
            <Check className="w-8 h-8 text-green-600" />
          </div>
          <p className="font-semibold text-gray-700">Tudo em dia!</p>
          <p className="text-sm text-gray-400">Nenhum item está abaixo do mínimo agora.</p>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <button onClick={compartilhar} className="btn-primary flex-1 flex items-center justify-center gap-2">
              <Share2 className="w-4 h-4" /> Compartilhar
            </button>
            <button onClick={abrirWhatsApp} className="btn-secondary flex items-center justify-center gap-2">
              WhatsApp
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
            {itens.map(p => {
              const pego = pegos.has(p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => togglePego(p.id)}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-50 transition-colors"
                >
                  <span className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                    pego ? 'bg-green-600 border-green-600' : 'border-gray-300'
                  }`}>
                    {pego && <Check className="w-4 h-4 text-white" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`font-medium truncate ${pego ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                      {p.nome}
                    </p>
                    <p className="text-xs text-gray-500">
                      Tem {p.quantidade} {p.unidade} · mínimo {p.estoque_minimo} {p.unidade}
                    </p>
                  </div>
                  <div className={`text-right shrink-0 ${pego ? 'opacity-40' : ''}`}>
                    <p className="text-xs text-gray-400">comprar</p>
                    <p className="font-bold text-red-800">~{faltam(p)} {p.unidade}</p>
                  </div>
                </button>
              )
            })}
          </div>

          <p className="text-xs text-gray-400 text-right">
            {pegos.size} de {itens.length} marcados
          </p>
        </>
      )}
    </div>
  )
}
