import { useState, useEffect, useRef } from 'react'
import { useProdutos } from '../hooks/useEstoque'
import { useAuth } from '../contexts/AuthContext'
import { registrarAjuste } from '../services/estoque'
import { analisarContagem, prepararImagem } from '../services/geminiVision'
import { expandirArquivosParaImagens } from '../lib/arquivos'
import { matchearComProdutos, recalcularGrupo, novoGrupoSemMatch } from '../lib/matching'
import { Modal } from '../components/Modal'
import { ClipboardCheck, Search, Camera, X, ArrowLeftRight, AlertTriangle } from 'lucide-react'
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

  // --- Fluxo de importação por foto ---
  const apiKey = localStorage.getItem('gemini_api_key') || ''
  const [fotoFase, setFotoFase] = useState('idle') // idle | lendo | confirmando | aplicando
  const [grupos, setGrupos] = useState([])
  const [picker, setPicker] = useState(null) // { grupoId } — seletor de produto aberto
  const [buscaPicker, setBuscaPicker] = useState('')
  const [zerosPendentes, setZerosPendentes] = useState(null) // array | null
  const fileRef = useRef()
  const cameraRef = useRef()

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

  // ---------------------------------------------------------------------------
  // Importação por foto
  // ---------------------------------------------------------------------------

  // Lê uma ou mais fotos, junta os itens e mescla com os grupos já existentes
  // (permite "adicionar outra foto"). Marcas diferentes do mesmo produto são
  // somadas no mesmo grupo.
  async function lerFotos(e) {
    const selecionados = Array.from(e.target.files)
    e.target.value = ''
    if (!selecionados.length) return
    if (!apiKey) return toast.error('Configure a chave da IA na aba "Foto IA" primeiro')

    setFotoFase('lendo')
    const t = toast.loading('Lendo foto(s)...')
    try {
      const imagens = await expandirArquivosParaImagens(selecionados)
      const lidos = []
      for (const img of imagens) {
        const { base64, mimeType } = await prepararImagem(img)
        const res = await analisarContagem(base64, mimeType, apiKey)
        lidos.push(...(res.itens || []))
      }
      if (lidos.length === 0) {
        toast.dismiss(t)
        toast.error('Nenhum item identificado na foto.')
        setFotoFase(grupos.length ? 'confirmando' : 'idle')
        return
      }
      const novos = matchearComProdutos(lidos, produtos)
      setGrupos(prev => mesclarGrupos(prev, novos))
      setFotoFase('confirmando')
      toast.dismiss(t)
      toast.success(`${lidos.length} item(ns) lido(s). Revise antes de aplicar.`)
    } catch (err) {
      toast.dismiss(t)
      toast.error('Falha ao ler a foto: ' + (err?.message || 'erro'), { duration: 6000 })
      setFotoFase(grupos.length ? 'confirmando' : 'idle')
    }
  }

  // Mescla grupos novos nos existentes: mesmo produto -> soma os itens no mesmo
  // card (mostra a procedência de cada foto). Total recalculado, salvo se o
  // usuário já tiver editado à mão.
  function mesclarGrupos(atuais, novos) {
    const saida = [...atuais]
    for (const g of novos) {
      if (g.produtoId) {
        const existente = saida.find(x => x.produtoId === g.produtoId && !x.pulado)
        if (existente) {
          existente.itens = [...existente.itens, ...g.itens]
          const r = recalcularGrupo(existente, existente.produtoUnidade)
          existente.itens = r.itens
          existente.totalCalculado = r.totalCalculado
          existente.total = r.total
          if (g.confianca === 'media') existente.confianca = 'media'
          existente.confirmado = false // mudou: pede reconferência
          continue
        }
      }
      saida.push(g)
    }
    return saida
  }

  function patchGrupo(id, patch) {
    setGrupos(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g))
  }

  function editarTotal(id, valor) {
    setGrupos(prev => prev.map(g => g.id === id ? { ...g, total: valor, totalEditado: true } : g))
  }

  function confirmarGrupo(id) {
    patchGrupo(id, { confirmado: true })
  }

  function pularGrupo(id) {
    patchGrupo(id, { pulado: true, confirmado: false })
  }

  function confirmarTodosAltos() {
    setGrupos(prev => prev.map(g =>
      (g.produtoId && !g.pulado && g.confianca === 'alta') ? { ...g, confirmado: true } : g
    ))
  }

  // Vincula/troca o produto de um grupo (recalcula as quantidades na nova unidade).
  function escolherProduto(grupoId, produto) {
    setGrupos(prev => prev.map(g => {
      if (g.id !== grupoId) return g
      const base = {
        ...g,
        produtoId: produto.id,
        produtoNome: produto.nome,
        produtoUnidade: produto.unidade,
        confianca: 'alta', // escolha manual = confiável
        totalEditado: false,
      }
      return recalcularGrupo(base, produto.unidade)
    }))
    setPicker(null)
    setBuscaPicker('')
  }

  // Remove um item de um grupo e o transforma num grupo "sem vínculo".
  function removerItem(grupoId, itemId) {
    setGrupos(prev => {
      let solto = null
      const mapeado = prev.map(g => {
        if (g.id !== grupoId) return g
        const item = g.itens.find(it => it.id === itemId)
        if (item) solto = item
        const itens = g.itens.filter(it => it.id !== itemId)
        if (itens.length === 0) return null
        const r = recalcularGrupo({ ...g, itens }, g.produtoUnidade)
        return r
      }).filter(Boolean)
      if (solto) mapeado.push(novoGrupoSemMatch(solto))
      return mapeado
    })
  }

  function ignorarGrupo(id) {
    setGrupos(prev => prev.filter(g => g.id !== id))
  }

  function fecharFoto() {
    setGrupos([])
    setFotoFase('idle')
    setPicker(null)
    setZerosPendentes(null)
  }

  // Grupos visíveis (não pulados)
  const gruposVisiveis = grupos.filter(g => !g.pulado)
  const gruposComProduto = gruposVisiveis.filter(g => g.produtoId)
  const gruposSemMatch = gruposVisiveis.filter(g => !g.produtoId)
  const confirmados = gruposComProduto.filter(g => g.confirmado)
  const altosPendentes = gruposComProduto.filter(g => g.confianca === 'alta' && !g.confirmado)
  const aRevisar = gruposComProduto.filter(g => g.confianca === 'media' && !g.confirmado)

  // Aplica os grupos confirmados via registrarAjuste. `pularAlerta` ignora a
  // checagem de produtos que vão a zero.
  async function aplicarFoto(pularAlerta = false) {
    const aplicaveis = confirmados.filter(g => {
      const v = parseFloat(String(g.total).replace(',', '.'))
      return !isNaN(v)
    })
    if (aplicaveis.length === 0) return toast.error('Confirme ao menos um produto antes de aplicar')

    // Checa produtos que passarão de >0 para 0.
    if (!pularAlerta) {
      const zeros = []
      for (const g of aplicaveis) {
        const v = parseFloat(String(g.total).replace(',', '.'))
        const prod = produtos.find(p => p.id === g.produtoId)
        if (prod && (prod.quantidade || 0) > 0 && v === 0) {
          zeros.push({ nome: prod.nome, atual: prod.quantidade, unidade: prod.unidade })
        }
      }
      if (zeros.length > 0) { setZerosPendentes(zeros); return }
    }

    setZerosPendentes(null)
    setFotoFase('aplicando')
    let ok = 0, erros = 0
    for (const g of aplicaveis) {
      try {
        const v = parseFloat(String(g.total).replace(',', '.'))
        await registrarAjuste(g.produtoId, v, 'Contagem por foto')
        ok++
      } catch { erros++ }
    }
    if (ok > 0) toast.success(`${ok} produto(s) ajustado(s) pela foto!`)
    if (erros > 0) toast.error(`${erros} produto(s) não puderam ser ajustados`)
    fecharFoto()
  }

  // Produtos filtrados no seletor (trocar/vincular)
  const produtosPicker = produtos.filter(p =>
    !buscaPicker || p.nome.toLowerCase().includes(buscaPicker.toLowerCase())
  )

  // ---------------------------------------------------------------------------
  // TELA DE CONFIRMAÇÃO (substitui a página enquanto ativa)
  // ---------------------------------------------------------------------------
  if (fotoFase === 'confirmando' || fotoFase === 'aplicando') {
    return (
      <div className="space-y-4 max-w-lg mx-auto pb-28">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-800">Conferir foto</h1>
          <button onClick={fecharFoto} className="text-sm text-gray-500 underline">Cancelar</button>
        </div>

        {/* Resumo + ações em massa */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-gray-600">
            <strong>{gruposComProduto.length}</strong> produto(s) identificado(s).
            Confira cada um e toque em <strong>Confirmar</strong>.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="bg-green-50 text-green-700 px-2 py-1 rounded-full">✓ {confirmados.length} confirmados</span>
            {aRevisar.length > 0 && <span className="bg-yellow-50 text-yellow-700 px-2 py-1 rounded-full">? {aRevisar.length} revisar</span>}
            {gruposSemMatch.length > 0 && <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded-full">✕ {gruposSemMatch.length} sem produto</span>}
          </div>
          {(() => {
            const deltas = gruposComProduto.map(g => {
              const sis = produtos.find(p => p.id === g.produtoId)?.quantidade ?? 0
              const t = parseFloat(String(g.total).replace(',', '.'))
              return isNaN(t) ? null : t - sis
            }).filter(d => d !== null)
            const sobra = deltas.filter(d => d > 0).length
            const falta = deltas.filter(d => d < 0).length
            return (sobra > 0 || falta > 0) ? (
              <div className="flex gap-3 text-xs">
                <span className="text-green-600">{sobra} sobra</span>
                <span className="text-red-600">{falta} falta</span>
              </div>
            ) : null
          })()}
          {altosPendentes.length > 0 && (
            <button onClick={confirmarTodosAltos} className="btn-secondary w-full text-sm">
              ✓ Confirmar os {altosPendentes.length} com alta confiança
            </button>
          )}
          <button onClick={() => fileRef.current.click()} className="text-sm text-red-700 underline w-full text-center">
            + Adicionar outra foto
          </button>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={lerFotos} />
        </div>

        {/* Cards de produto */}
        {gruposComProduto.map(g => (
          <GrupoCard
            key={g.id}
            grupo={g}
            produto={produtos.find(p => p.id === g.produtoId)}
            onTrocar={() => { setBuscaPicker(''); setPicker({ grupoId: g.id }) }}
            onRemoverItem={(itemId) => removerItem(g.id, itemId)}
            onEditarTotal={(v) => editarTotal(g.id, v)}
            onConfirmar={() => confirmarGrupo(g.id)}
            onPular={() => pularGrupo(g.id)}
          />
        ))}

        {/* Itens sem produto no estoque */}
        {gruposSemMatch.length > 0 && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-sm font-semibold text-gray-600 flex items-center gap-2">
              <X className="w-4 h-4" /> Sem produto no estoque
            </p>
            {gruposSemMatch.map(g => (
              <div key={g.id} className="bg-white border border-gray-200 rounded-lg p-3">
                <p className="text-sm font-medium text-gray-800">{g.itens[0]?.nomeOriginal}</p>
                <p className="text-xs text-gray-500 mb-2">Quantidade lida: {g.itens[0]?.quantidade}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setBuscaPicker(''); setPicker({ grupoId: g.id }) }}
                    className="btn-secondary text-xs flex-1"
                  >
                    Vincular a produto
                  </button>
                  <button onClick={() => ignorarGrupo(g.id)} className="btn-secondary text-xs flex-1">
                    Ignorar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Rodapé fixo: aplicar */}
        <div className="fixed bottom-16 left-0 right-0 p-3 bg-gradient-to-t from-gray-50 via-gray-50 to-transparent">
          <div className="max-w-lg mx-auto">
            <button
              onClick={() => aplicarFoto(false)}
              disabled={fotoFase === 'aplicando' || confirmados.length === 0}
              className="btn-primary w-full text-base py-3 disabled:opacity-50 shadow-lg"
            >
              {fotoFase === 'aplicando'
                ? 'Salvando...'
                : `Aplicar ${confirmados.length} produto(s) na contagem`}
            </button>
          </div>
        </div>

        {/* Seletor de produto */}
        {picker && (
          <Modal title="Escolher produto" onClose={() => { setPicker(null); setBuscaPicker('') }}>
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
                    onClick={() => escolherProduto(picker.grupoId, p)}
                    className="w-full text-left py-3 px-1 hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-sm font-medium text-gray-800">{p.nome}</span>
                    <span className="text-xs text-gray-400 ml-2">{p.quantidade} {p.unidade}</span>
                  </button>
                ))}
              </div>
            </div>
          </Modal>
        )}

        {/* Alerta de produtos que vão a zero */}
        {zerosPendentes && (
          <Modal title="Atenção" onClose={() => setZerosPendentes(null)}>
            <div className="space-y-4">
              <div className="flex gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0" />
                <p className="text-sm text-yellow-800">
                  <strong>{zerosPendentes.length} produto(s) passarão para zero.</strong> Confira se está certo:
                </p>
              </div>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {zerosPendentes.map((z, i) => (
                  <div key={i} className="flex items-center justify-between text-sm border-b border-gray-100 py-1.5">
                    <span className="text-gray-700">{z.nome}</span>
                    <span className="text-gray-400">{z.atual} {z.unidade} → <strong className="text-red-600">0</strong></span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setZerosPendentes(null)} className="btn-secondary flex-1">Voltar e revisar</button>
                <button onClick={() => aplicarFoto(true)} className="btn-primary flex-1">Aplicar assim mesmo</button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // TELA NORMAL (contagem manual + botão de importar foto)
  // ---------------------------------------------------------------------------
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

      {/* Importar por foto */}
      <button
        onClick={() => fileRef.current.click()}
        disabled={fotoFase === 'lendo'}
        className="w-full flex items-center justify-center gap-2 bg-red-50 hover:bg-red-100 text-red-800 font-semibold py-3 rounded-xl border border-red-200 transition-colors disabled:opacity-50"
      >
        <Camera className="w-5 h-5" />
        {fotoFase === 'lendo' ? 'Lendo foto...' : 'Importar contagem por foto'}
      </button>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={lerFotos} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={lerFotos} />

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

// Card de um produto na tela de confirmação por foto.
function GrupoCard({ grupo, produto, onTrocar, onRemoverItem, onEditarTotal, onConfirmar, onPular }) {
  const confirmado = grupo.confirmado
  const sistema = produto?.quantidade ?? 0
  const totalNum = parseFloat(String(grupo.total).replace(',', '.'))
  const delta = isNaN(totalNum) ? null : Math.round((totalNum - sistema) * 1000) / 1000
  const cor = confirmado
    ? 'border-green-300 bg-green-50'
    : grupo.confianca === 'media'
      ? 'border-yellow-300 bg-yellow-50'
      : 'border-gray-200 bg-white'
  const icone = confirmado ? '✓' : grupo.confianca === 'media' ? '?' : '✓'

  return (
    <div className={`border rounded-xl p-4 space-y-3 ${cor}`}>
      <div className="flex items-start gap-2">
        <span className={`text-lg font-bold ${confirmado ? 'text-green-600' : grupo.confianca === 'media' ? 'text-yellow-600' : 'text-gray-400'}`}>
          {icone}
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-800 leading-tight">{grupo.produtoNome}</p>
          <button onClick={onTrocar} className="text-xs text-red-700 underline flex items-center gap-1 mt-0.5">
            <ArrowLeftRight className="w-3 h-3" /> trocar produto
          </button>
        </div>
        <span className="text-xs text-gray-400 shrink-0">{grupo.produtoUnidade}</span>
      </div>

      {/* Procedência: cada linha lida da foto */}
      <div className="space-y-1 pl-7">
        {grupo.itens.map(it => (
          <div key={it.id} className="flex items-center gap-2 text-xs text-gray-600">
            <span className="flex-1 min-w-0 truncate">
              {it.nomeOriginal} → <strong>{it.quantidadeCalculada}</strong> {grupo.produtoUnidade}
              {it.incerto && <span className="text-yellow-600"> (confira)</span>}
            </span>
            {grupo.itens.length > 1 && (
              <button onClick={() => onRemoverItem(it.id)} className="text-gray-300 hover:text-red-500 shrink-0" aria-label="Remover deste grupo">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Total editável */}
      <div className="flex items-center gap-2 pl-7">
        <label className="text-sm text-gray-600">Total:</label>
        <input
          type="number" min="0" step="0.001" inputMode="decimal"
          value={grupo.total}
          onChange={e => onEditarTotal(e.target.value)}
          className="input w-28 text-base font-semibold text-right"
        />
        <span className="text-sm text-gray-400">{grupo.produtoUnidade}</span>
      </div>

      {/* Diferença vs. estoque do sistema (sobra/falta) */}
      {delta !== null && (
        <p className="text-xs pl-7 text-gray-500">
          Sistema: {sistema} {grupo.produtoUnidade} ·{' '}
          {delta === 0
            ? <span className="text-gray-400">sem diferença</span>
            : delta > 0
              ? <span className="text-green-600 font-semibold">+{delta} sobra</span>
              : <span className="text-red-600 font-semibold">{delta} falta</span>}
        </p>
      )}

      {/* Ações */}
      <div className="flex gap-2 pt-1">
        <button onClick={onPular} className="btn-secondary flex-1 text-sm">Pular</button>
        <button
          onClick={onConfirmar}
          className={`flex-1 text-sm font-semibold px-4 py-2 rounded-lg transition-colors ${
            confirmado
              ? 'bg-green-600 text-white'
              : 'bg-red-800 hover:bg-red-900 text-white'
          }`}
        >
          {confirmado ? '✓ Confirmado' : 'Confirmar'}
        </button>
      </div>
    </div>
  )
}
