import { useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from './Modal'

// Seletor de produto com busca por nome (Modal). Reutilizável.
// - produtos: lista a exibir.
// - excluirIds: ids a ocultar (ex: insumos já adicionados).
// - onEscolher(produto): chamado ao tocar num produto.
// - opcaoExtra: { label, onEscolher } — botão fixo no topo (ex: "criar novo").
export function SeletorProduto({ titulo = 'Escolher produto', produtos, excluirIds = [], onEscolher, onClose, opcaoExtra }) {
  const [busca, setBusca] = useState('')
  const lista = produtos.filter(p =>
    !excluirIds.includes(p.id) &&
    (!busca || p.nome.toLowerCase().includes(busca.toLowerCase()))
  )

  return (
    <Modal title={titulo} onClose={onClose}>
      <div className="space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            autoFocus
            placeholder="Buscar produto..."
            value={busca}
            onChange={e => setBusca(e.target.value)}
            className="input pl-9"
          />
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
          {opcaoExtra && (
            <button
              onClick={() => opcaoExtra.onEscolher(busca)}
              className="w-full text-left py-3 px-1 hover:bg-gray-50 transition-colors text-sm font-medium text-red-700"
            >
              {opcaoExtra.label}
            </button>
          )}
          {lista.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">Nenhum produto encontrado.</p>
          ) : lista.map(p => (
            <button
              key={p.id}
              onClick={() => onEscolher(p)}
              className="w-full text-left py-3 px-1 hover:bg-gray-50 transition-colors flex items-center justify-between gap-2"
            >
              <span className="text-sm font-medium text-gray-800 truncate">{p.nome}</span>
              <span className="text-xs text-gray-400 shrink-0">{p.unidade}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
