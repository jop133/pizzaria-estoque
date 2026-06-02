import { useState, useRef } from 'react'
import { useProdutos, useFichas } from '../hooks/useEstoque'
import { analisarImagemEstoque, prepararImagem, agruparPorTipo } from '../services/geminiVision'
import { registrarEntrada, registrarSaidaManual, registrarSaidaFicha } from '../services/estoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

const tipoLabel = { entrada: 'Entrada', saida_ficha: 'Saída por Ficha', saida_manual: 'Saída Manual', desconhecido: 'Não identificado' }
const tipoCor = { entrada: 'green', saida_ficha: 'orange', saida_manual: 'red', desconhecido: 'gray' }
const UNIDADES_PESO = ['kg', 'g', 'l', 'ml']

export function ImportarFoto() {
  const produtos = useProdutos()
  const fichas = useFichas()

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '')
  const [editandoChave, setEditandoChave] = useState(!localStorage.getItem('gemini_api_key'))
  const [chaveTemp, setChaveTemp] = useState('')

  const [fila, setFila] = useState([])
  const [confirmando, setConfirmando] = useState(false)

  const fileRef = useRef()
  const cameraRef = useRef()

  function salvarChave() {
    const chave = chaveTemp.trim()
    if (chave.length < 20) return toast.error('Chave inválida. Verifique e tente novamente.')
    localStorage.setItem('gemini_api_key', chave)
    setApiKey(chave)
    setEditandoChave(false)
    toast.success('Chave salva!')
  }

  function adicionarArquivos(e) {
    const files = Array.from(e.target.files)
    if (!files.length) return
    const novas = files.map(file => ({
      id: Math.random().toString(36).slice(2),
      url: URL.createObjectURL(file),
      file,
      status: 'aguardando',
      resultado: null,
      itens: [],
    }))
    setFila(prev => [...prev, ...novas])
    e.target.value = ''
  }

  function removerFoto(id) {
    setFila(prev => prev.filter(f => f.id !== id))
  }

  // Verifica se todas as palavras do nome cadastrado aparecem como palavras inteiras na busca
  function matchPorPalavras(nomeCadastrado, busca) {
    const palavrasBusca = busca.split(/\s+/)
    const palavrasCadastro = nomeCadastrado.split(/\s+/).filter(p => p.length >= 3)
    if (palavrasCadastro.length === 0) return false
    return palavrasCadastro.every(pc => palavrasBusca.some(pb => pb === pc))
  }

  function encontrarProdutoId(nomeCadastrado, nome) {
    // Se a IA indicou nomeCadastrado, usa só correspondência exata
    if (nomeCadastrado) {
      const exato = produtos.find(p => p.nome.toLowerCase() === nomeCadastrado.toLowerCase())
      return exato?.id ?? null
    }
    const busca = (nome || '').toLowerCase()
    const exato = produtos.find(p => p.nome.toLowerCase() === busca)
    if (exato) return exato.id
    // Parcial: só aceita se todas as palavras do produto aparecem como palavras inteiras na busca
    const parcial = produtos.find(p => matchPorPalavras(p.nome.toLowerCase(), busca))
    return parcial?.id ?? null
  }

  // Fator para converter o peso da embalagem na unidade do produto cadastrado.
  function fatorConversao(produtoU, pesoU) {
    const fatores = {
      'kg|g': 1 / 1000, 'kg|kg': 1, 'g|kg': 1000, 'g|g': 1,
      'l|ml': 1 / 1000, 'l|l': 1, 'ml|l': 1000, 'ml|ml': 1,
    }
    return fatores[`${produtoU}|${pesoU}`]
  }

  const normalizar = s => (s || '').trim().toLowerCase()

  // Item que será criado como produto novo (não cadastrado, ativo, sem ficha e
  // a foto não é saída por ficha).
  function ehProdutoNovo(item, tipoFoto) {
    return item.ativo && !item.produtoId && !item.fichaId && tipoFoto !== 'saida_ficha'
  }

  // Quantos itens (em toda a fila) serão unidos no mesmo produto novo.
  function contarNoGrupo(baseKey) {
    let n = 0
    for (const f of fila) {
      if (f.status !== 'pronto') continue
      for (const it of f.itens) {
        if (ehProdutoNovo(it, f.resultado?.tipo) && normalizar(it.nomeBase || it.nome) === baseKey) n++
      }
    }
    return n
  }

  // Unidade-base para um peso lido: g/kg -> kg, ml/l -> l. Senão null.
  function unidadeBaseDoPeso(unidadePeso) {
    const u = (unidadePeso || '').toLowerCase()
    if (u === 'g' || u === 'kg') return 'kg'
    if (u === 'ml' || u === 'l') return 'l'
    return null
  }

  // A IA leu um peso/volume de embalagem válido para este item?
  function temPeso(item) {
    const valor = parseFloat(String(item.pesoEmbalagem ?? '').replace(',', '.'))
    return !!valor && UNIDADES_PESO.includes((item.unidadeEmbalagem || '').toLowerCase())
  }

  // Unidade em que o item será contabilizado no estoque:
  // - produto já vinculado: a unidade dele.
  // - produto novo com peso lido: a unidade-base do peso (kg/l).
  // - caso contrário: a unidade lida pela IA ou 'un'.
  function unidadeAlvoDoItem(item, produtoVinculado) {
    if (produtoVinculado) return (produtoVinculado.unidade || '').toLowerCase()
    if (temPeso(item)) return unidadeBaseDoPeso(item.unidadeEmbalagem)
    return (item.unidade || 'un').toLowerCase()
  }

  // Calcula o total que vai para o estoque a partir de contagem x peso.
  // Retorna { precisaPeso, total }. precisaPeso=true quando o produto é
  // por peso/volume mas o peso da embalagem não foi informado.
  function calcularTotal(item, produtoUnidade) {
    const u = (produtoUnidade || '').toLowerCase()
    const count = parseFloat(item.quantidade) || 0
    if (!UNIDADES_PESO.includes(u)) return { precisaPeso: false, total: count }

    const valor = parseFloat(String(item.pesoEmbalagem ?? '').replace(',', '.'))
    const pu = (item.unidadeEmbalagem || '').toLowerCase()
    const fator = fatorConversao(u, pu)
    if (!valor || fator === undefined) return { precisaPeso: true, total: null }
    return { precisaPeso: false, total: Math.round(count * valor * fator * 1000) / 1000 }
  }

  function encontrarFichaId(nomeCadastrado, nome) {
    if (nomeCadastrado) {
      const exato = fichas.find(f => f.nome.toLowerCase() === nomeCadastrado.toLowerCase())
      return exato?.id ?? null
    }
    const busca = (nome || '').toLowerCase()
    const exato = fichas.find(f => f.nome.toLowerCase() === busca)
    if (exato) return exato.id
    const parcial = fichas.find(f => matchPorPalavras(f.nome.toLowerCase(), busca))
    return parcial?.id ?? null
  }

  // Monta um item da revisão a partir do que a IA leu, resolvendo vínculo,
  // peso/volume e nomeBase (tipo do produto, vindo do agrupamento por texto).
  function construirItem(item, mapaBase) {
    const nomeBase = (mapaBase[(item.nome || '').trim()] || item.nome || '').trim()

    // Vínculo: tenta pelo nome lido; se não achar, tenta pelo nomeBase (tipo).
    let produtoId = encontrarProdutoId(item.nomeCadastrado, item.nome)
    if (!produtoId && nomeBase) produtoId = encontrarProdutoId(null, nomeBase)
    let fichaId = encontrarFichaId(item.nomeCadastrado, item.nome)
    if (!fichaId && nomeBase) fichaId = encontrarFichaId(null, nomeBase)

    const prod = produtos.find(p => p.id === produtoId)
    const prodUnidade = (prod?.unidade || '').toLowerCase()

    let pesoEmbalagem = item.pesoEmbalagem ?? ''
    let unidadeEmbalagem = (item.unidadeEmbalagem || '').toLowerCase()
    // Se a IA não preencheu peso/volume explícito (comum em líquidos),
    // tenta extrair do próprio nome do item (ex: "OLEO 900ML" -> 900 ml).
    const temExplicito = String(pesoEmbalagem).trim() !== '' && UNIDADES_PESO.includes(unidadeEmbalagem)
    if (!temExplicito) {
      const m = (item.nome || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i)
      if (m) {
        pesoEmbalagem = parseFloat(m[1].replace(',', '.'))
        unidadeEmbalagem = m[2].toLowerCase()
      }
    }
    // Se o produto é por peso e ainda não há unidade da embalagem,
    // assume a própria unidade do produto como padrão para o usuário ajustar.
    if (UNIDADES_PESO.includes(prodUnidade) && !UNIDADES_PESO.includes(unidadeEmbalagem)) {
      unidadeEmbalagem = prodUnidade
    }
    return {
      ...item,
      ativo: true,
      marca: item.marca || '',
      produtoId,
      fichaId,
      quantidade: item.quantidade ?? 1,
      pesoEmbalagem,
      unidadeEmbalagem,
      nomeBase,
    }
  }

  async function analisarTodas() {
    if (!apiKey) return toast.error('Configure a chave da API primeiro')
    const pendentes = fila.filter(f => f.status === 'aguardando')
    if (!pendentes.length) return toast.error('Nenhuma foto aguardando análise')

    // 1) Leitura por visão (uma chamada por foto) — inalterada.
    const analisadas = []
    for (const foto of pendentes) {
      setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'analisando' } : f))
      try {
        const { base64, mimeType } = await prepararImagem(foto.file)
        const res = await analisarImagemEstoque(base64, mimeType, produtos, fichas, apiKey)
        analisadas.push({ fotoId: foto.id, res })
      } catch (e) {
        setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'erro', erro: e.message } : f))
      }
    }

    // 2) Agrupamento por tipo: 1 chamada SÓ DE TEXTO para todo o lote.
    //    Falha ou limite => sem agrupamento (fallback), nunca quebra.
    const todosNomes = analisadas.flatMap(a => (a.res.itens || []).map(it => it.nome))
    let mapaBase = {}
    try {
      mapaBase = await agruparPorTipo(todosNomes, apiKey)
    } catch {
      mapaBase = {}
    }

    // 3) Monta os itens (vínculo + peso + nomeBase) e marca as fotos como prontas.
    for (const { fotoId, res } of analisadas) {
      const itens = (res.itens || []).map(item => construirItem(item, mapaBase))
      setFila(prev => prev.map(f => f.id === fotoId ? { ...f, status: 'pronto', resultado: res, itens } : f))
    }
    toast.success('Análise concluída! Revise os itens antes de confirmar.')
  }

  function atualizarItem(fotoId, itemIdx, campo, valor) {
    setFila(prev => prev.map(f => {
      if (f.id !== fotoId) return f
      const itens = f.itens.map((it, i) => i === itemIdx ? { ...it, [campo]: valor } : it)
      return { ...f, itens }
    }))
  }

  async function confirmarTodos() {
    const prontas = fila.filter(f => f.status === 'pronto')
    if (!prontas.length) return toast.error('Nenhuma foto analisada para confirmar')

    setConfirmando(true)
    let ok = 0
    let criados = 0
    let erros = 0
    let semPeso = 0
    // Índices lançados com sucesso por foto, para não relançar em nova confirmação.
    const lancadosPorFoto = {}
    // Produtos novos criados nesta confirmação, por nomeBase, para unir itens
    // não cadastrados do mesmo tipo num único produto.
    const criadosPorBase = {}

    for (const foto of prontas) {
      lancadosPorFoto[foto.id] = new Set()
      for (let i = 0; i < foto.itens.length; i++) {
        const item = foto.itens[i]
        if (!item.ativo) continue
        try {
          let produtoId = item.produtoId
          let fichaId = item.fichaId
          const vaiCriar = !produtoId && !fichaId && foto.resultado.tipo !== 'saida_ficha'

          // Unidade em que o item será contabilizado (produto existente, novo
          // com peso, ou unidade simples). Definida ANTES de criar o produto.
          let unidadeAlvo
          if (produtoId) {
            unidadeAlvo = (produtos.find(p => p.id === produtoId)?.unidade || '').toLowerCase()
          } else if (vaiCriar) {
            unidadeAlvo = unidadeAlvoDoItem(item, null)
          }

          // Total que vai para o estoque: contagem x peso convertido (unidades
          // de peso/volume) ou a própria contagem. Calculado antes de criar para
          // não gerar produto quando o peso ainda falta.
          let quantidadeFinal = parseFloat(item.quantidade) || 0
          if (!fichaId && UNIDADES_PESO.includes(unidadeAlvo)) {
            const { precisaPeso, total } = calcularTotal(item, unidadeAlvo)
            if (precisaPeso || !total) { semPeso++; continue }
            quantidadeFinal = total
          }

          if (vaiCriar) {
            const baseKey = normalizar(item.nomeBase || item.nome)
            if (criadosPorBase[baseKey]) {
              // Já criado nesta confirmação por outro item do mesmo tipo: reaproveita.
              produtoId = criadosPorBase[baseKey]
            } else {
              const nomeNovo = (item.nomeBase || item.nome || '').trim()
              const { data: novo } = await supabase.from('produtos').insert({
                organizacao_id: session.organizacaoId,
                nome: nomeNovo,
                categoria: 'Outros',
                unidade: unidadeAlvo || 'un',
                quantidade: 0,
                estoque_minimo: 0,
              }).select().single()
              produtoId = novo?.id
              if (produtoId) criadosPorBase[baseKey] = produtoId
              criados++
            }
          }

          if (foto.resultado.tipo === 'entrada') {
            if (!produtoId) { erros++; continue }
            await registrarEntrada(produtoId, quantidadeFinal, 'Importado por foto', item.marca || '')
          } else if (foto.resultado.tipo === 'saida_ficha') {
            if (fichaId) await registrarSaidaFicha(fichaId, quantidadeFinal, 'Importado por foto')
            else if (produtoId) await registrarSaidaManual(produtoId, quantidadeFinal, 'Importado por foto')
            else { erros++; continue }
          } else {
            if (!produtoId) { erros++; continue }
            await registrarSaidaManual(produtoId, quantidadeFinal, 'Importado por foto')
          }
          ok++
          lancadosPorFoto[foto.id].add(i)
        } catch { erros++ }
      }
    }

    setConfirmando(false)

    // Remove fotos totalmente lançadas; nas que sobraram itens (ex: sem peso),
    // desativa os já lançados para não duplicar e mantém o resto para revisão.
    setFila(prev => prev.flatMap(f => {
      const lancados = lancadosPorFoto[f.id]
      if (!lancados) return [f]
      const itens = f.itens.map((it, i) => lancados.has(i) ? { ...it, ativo: false } : it)
      const restantes = itens.filter(it => it.ativo)
      if (restantes.length === 0) return []
      return [{ ...f, itens }]
    }))

    if (ok > 0) {
      const msg = criados > 0 ? `${ok} item(ns) lançado(s)! ${criados} produto(s) criado(s) automaticamente.` : `${ok} item(ns) lançado(s) no estoque!`
      toast.success(msg)
    }
    if (semPeso > 0) toast.error(`${semPeso} item(ns) sem peso da embalagem — preencha o peso e confirme novamente`, { duration: 5000 })
    if (erros > 0) toast.error(`${erros} item(ns) não puderam ser lançados`)
  }

  const totalProntas = fila.filter(f => f.status === 'pronto').length
  const totalItensAtivos = fila.filter(f => f.status === 'pronto').reduce((s, f) => s + f.itens.filter(i => i.ativo).length, 0)

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-800">Importar por Foto</h1>

      {editandoChave ? (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-blue-800">🔑 Configure sua chave Groq (gratuita)</p>
          <p className="text-xs text-blue-600">Obtenha em: <span className="font-mono">console.groq.com</span></p>
          <input className="input" placeholder="gsk_..." value={chaveTemp} onChange={e => setChaveTemp(e.target.value)} />
          <button onClick={salvarChave} className="btn-primary w-full">Salvar Chave</button>
        </div>
      ) : (
        <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <p className="text-sm text-green-700 font-medium">✅ API Groq configurada</p>
          <button onClick={() => { setChaveTemp(apiKey); setEditandoChave(true) }} className="text-xs text-green-600 underline">Alterar</button>
        </div>
      )}

      <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 text-center space-y-3">
        <p className="text-4xl">📷</p>
        <p className="text-sm text-gray-500">Selecione uma ou várias fotos de uma vez</p>
        <div className="flex gap-2 justify-center flex-wrap">
          <button onClick={() => fileRef.current.click()} className="btn-secondary text-sm">📁 Escolher arquivos</button>
          <button onClick={() => cameraRef.current.click()} className="btn-secondary text-sm">📷 Tirar foto</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={adicionarArquivos} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={adicionarArquivos} />
      </div>

      {fila.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-600">{fila.length} foto(s) na fila</p>
            <button
              onClick={analisarTodas}
              disabled={!fila.some(f => f.status === 'aguardando') || !apiKey}
              className="btn-primary text-sm disabled:opacity-50"
            >
              🔍 Analisar {fila.filter(f => f.status === 'aguardando').length > 0 ? `(${fila.filter(f => f.status === 'aguardando').length})` : ''}
            </button>
          </div>

          {fila.map(foto => (
            <div key={foto.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 p-3 border-b border-gray-100">
                <img src={foto.url} alt="" className="w-14 h-14 object-cover rounded-lg shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-700 truncate">{foto.file.name}</p>
                  <div className="mt-1">
                    {foto.status === 'aguardando' && <Badge color="gray">Aguardando análise</Badge>}
                    {foto.status === 'analisando' && (
                      <span className="flex items-center gap-1 text-xs text-blue-600">
                        <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                        Analisando...
                      </span>
                    )}
                    {foto.status === 'pronto' && <Badge color={tipoCor[foto.resultado.tipo]}>{tipoLabel[foto.resultado.tipo]}</Badge>}
                    {foto.status === 'erro' && <Badge color="red">Erro na análise</Badge>}
                  </div>
                </div>
                <button onClick={() => removerFoto(foto.id)} className="text-gray-300 hover:text-red-500 text-lg shrink-0">✕</button>
              </div>

              {foto.status === 'erro' && (
                <p className="text-xs text-red-600 p-3">{foto.erro}</p>
              )}

              {foto.status === 'pronto' && (
                <div className="p-3 space-y-2">
                  <p className="text-xs text-gray-500">{foto.resultado.descricao}</p>
                  {foto.resultado.observacao && (
                    <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1">⚠️ {foto.resultado.observacao}</p>
                  )}
                  <div className="space-y-2">
                    {foto.itens.map((item, i) => {
                      const produtoVinculado = produtos.find(p => p.id === item.produtoId)
                      const fichaVinculada = fichas.find(f => f.id === item.fichaId)
                      const vinculo = fichaVinculada || produtoVinculado
                      // Unidade-alvo: do produto vinculado, ou (produto novo) a base do peso lido.
                      const unidadeAlvo = unidadeAlvoDoItem(item, produtoVinculado)
                      const usaPeso = !fichaVinculada && foto.resultado.tipo !== 'saida_ficha' && UNIDADES_PESO.includes(unidadeAlvo)
                      const { precisaPeso, total } = usaPeso ? calcularTotal(item, unidadeAlvo) : { precisaPeso: false, total: null }
                      return (
                        <div key={i} className={`border rounded-lg p-2 space-y-2 ${!item.ativo ? 'border-gray-100 opacity-50' : precisaPeso ? 'border-yellow-300 bg-yellow-50' : 'border-gray-200'}`}>
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox" checked={item.ativo}
                              onChange={e => atualizarItem(foto.id, i, 'ativo', e.target.checked)}
                              className="w-4 h-4 accent-red-600 shrink-0"
                            />
                            <span className="text-sm font-medium text-gray-800 truncate">{item.nome}</span>
                            {!vinculo && <Badge color="red">Sem vínculo</Badge>}
                          </div>
                          {usaPeso ? (
                            <div className="ml-6 space-y-2">
                              <div className="flex items-end gap-1.5 flex-wrap">
                                <div className="w-16">
                                  <label className="label">Qtd</label>
                                  <input
                                    type="number" min="0" step="1"
                                    className="input text-sm px-2"
                                    value={item.quantidade}
                                    onChange={e => atualizarItem(foto.id, i, 'quantidade', parseFloat(e.target.value) || 0)}
                                  />
                                </div>
                                <span className="pb-2 text-gray-400 text-sm">×</span>
                                <div className="w-20">
                                  <label className="label">Peso/un</label>
                                  <input
                                    type="number" min="0" step="0.001"
                                    className="input text-sm px-2"
                                    placeholder="?"
                                    value={item.pesoEmbalagem}
                                    onChange={e => atualizarItem(foto.id, i, 'pesoEmbalagem', e.target.value)}
                                  />
                                </div>
                                <div className="w-16">
                                  <label className="label">Un</label>
                                  <select
                                    className="input text-sm px-1"
                                    value={item.unidadeEmbalagem}
                                    onChange={e => atualizarItem(foto.id, i, 'unidadeEmbalagem', e.target.value)}
                                  >
                                    {UNIDADES_PESO.map(u => <option key={u} value={u}>{u}</option>)}
                                  </select>
                                </div>
                                <span className="pb-2 text-gray-400 text-sm">=</span>
                                <div className="pb-2 text-sm font-semibold text-gray-700">
                                  {precisaPeso ? <span className="text-yellow-700">informe o peso</span> : `${total} ${unidadeAlvo}`}
                                </div>
                              </div>
                              <div>
                                <label className="label">Produto</label>
                                <select
                                  className="input text-sm"
                                  value={item.produtoId ?? ''}
                                  onChange={e => atualizarItem(foto.id, i, 'produtoId', parseInt(e.target.value) || null)}
                                >
                                  <option value="">-- não vincular --</option>
                                  {produtos.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
                                </select>
                              </div>
                            </div>
                          ) : (
                          <div className="grid grid-cols-2 gap-2 ml-6">
                            <div>
                              <label className="label">Quantidade</label>
                              <input
                                type="number" min="0.001" step="0.001"
                                className="input text-sm"
                                value={item.quantidade}
                                onChange={e => atualizarItem(foto.id, i, 'quantidade', parseFloat(e.target.value) || 0)}
                              />
                            </div>
                            <div>
                              <label className="label">Produto/Ficha</label>
                              {foto.resultado.tipo === 'saida_ficha' ? (
                                <select
                                  className="input text-sm"
                                  value={item.fichaId ?? item.produtoId ?? ''}
                                  onChange={e => {
                                    const val = parseInt(e.target.value)
                                    const isFicha = fichas.some(f => f.id === val)
                                    atualizarItem(foto.id, i, 'fichaId', isFicha ? val : null)
                                    atualizarItem(foto.id, i, 'produtoId', isFicha ? null : val)
                                  }}
                                >
                                  <option value="">-- não vincular --</option>
                                  <optgroup label="Fichas">{fichas.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}</optgroup>
                                  <optgroup label="Produtos">{produtos.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}</optgroup>
                                </select>
                              ) : (
                                <select
                                  className="input text-sm"
                                  value={item.produtoId ?? ''}
                                  onChange={e => atualizarItem(foto.id, i, 'produtoId', parseInt(e.target.value) || null)}
                                >
                                  <option value="">-- não vincular --</option>
                                  {produtos.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
                                </select>
                              )}
                            </div>
                          </div>
                          )}
                          {foto.resultado.tipo === 'entrada' && (
                            <div className="ml-6">
                              <label className="label">Marca (opcional)</label>
                              <input
                                className="input text-sm"
                                placeholder="Ex: Tio João"
                                value={item.marca || ''}
                                onChange={e => atualizarItem(foto.id, i, 'marca', e.target.value)}
                              />
                            </div>
                          )}
                          {!vinculo && foto.resultado.tipo !== 'saida_ficha' && (
                            <div className="ml-6">
                              <label className="label">Criar como (itens com o mesmo nome são unidos)</label>
                              <input
                                className="input text-sm"
                                placeholder="Ex: Queijo Mussarela"
                                value={item.nomeBase || ''}
                                onChange={e => atualizarItem(foto.id, i, 'nomeBase', e.target.value)}
                              />
                              {(() => {
                                const n = contarNoGrupo(normalizar(item.nomeBase || item.nome))
                                return n > 1
                                  ? <p className="text-xs text-blue-600 mt-1">🔗 será unido com {n - 1} outro(s) item(ns) deste tipo</p>
                                  : <p className="text-xs text-gray-400 mt-1">novo produto</p>
                              })()}
                            </div>
                          )}
                          {vinculo && <p className="ml-6 text-xs text-green-600">✓ {vinculo.nome}</p>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}

          {totalProntas > 0 && (
            <button
              onClick={confirmarTodos}
              disabled={confirmando || totalItensAtivos === 0}
              className="btn-primary w-full disabled:opacity-50"
            >
              {confirmando ? 'Lançando...' : `✅ Confirmar e Lançar ${totalItensAtivos} item(ns) de ${totalProntas} foto(s)`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
