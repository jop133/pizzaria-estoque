import { useState, useRef } from 'react'
import { useProdutos, useFichas } from '../hooks/useEstoque'
import { analisarImagemEstoque, fileToBase64 } from '../services/geminiVision'
import { registrarEntrada, registrarSaidaManual, registrarSaidaFicha } from '../services/estoque'
import { supabase } from '../lib/supabase'
import { session } from '../lib/session'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

const tipoLabel = { entrada: 'Entrada', saida_ficha: 'Saída por Ficha', saida_manual: 'Saída Manual', desconhecido: 'Não identificado' }
const tipoCor = { entrada: 'green', saida_ficha: 'orange', saida_manual: 'red', desconhecido: 'gray' }

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

  function encontrarProdutoId(nomeCadastrado, nome) {
    const busca = (nomeCadastrado || nome || '').toLowerCase()
    const exato = produtos.find(p => p.nome.toLowerCase() === busca)
    if (exato) return exato.id
    const parcial = produtos.find(p => p.nome.toLowerCase().includes(busca) || busca.includes(p.nome.toLowerCase()))
    return parcial?.id ?? null
  }

  function encontrarFichaId(nomeCadastrado, nome) {
    const busca = (nomeCadastrado || nome || '').toLowerCase()
    const exato = fichas.find(f => f.nome.toLowerCase() === busca)
    if (exato) return exato.id
    const parcial = fichas.find(f => f.nome.toLowerCase().includes(busca) || busca.includes(f.nome.toLowerCase()))
    return parcial?.id ?? null
  }

  async function analisarTodas() {
    if (!apiKey) return toast.error('Configure a chave da API primeiro')
    const pendentes = fila.filter(f => f.status === 'aguardando')
    if (!pendentes.length) return toast.error('Nenhuma foto aguardando análise')

    for (const foto of pendentes) {
      setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'analisando' } : f))
      try {
        const base64 = await fileToBase64(foto.file)
        const mimeType = foto.file.type || 'image/jpeg'
        const res = await analisarImagemEstoque(base64, mimeType, produtos, fichas, apiKey)
        const itens = res.itens.map(item => ({
          ...item,
          ativo: true,
          produtoId: encontrarProdutoId(item.nomeCadastrado, item.nome),
          fichaId: encontrarFichaId(item.nomeCadastrado, item.nome),
        }))
        setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'pronto', resultado: res, itens } : f))
      } catch (e) {
        setFila(prev => prev.map(f => f.id === foto.id ? { ...f, status: 'erro', erro: e.message } : f))
      }
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

    for (const foto of prontas) {
      for (const item of foto.itens.filter(i => i.ativo)) {
        try {
          let produtoId = item.produtoId
          let fichaId = item.fichaId

          if (!produtoId && !fichaId && foto.resultado.tipo !== 'saida_ficha') {
            const { data: novo } = await supabase.from('produtos').insert({
              organizacao_id: session.organizacaoId,
              nome: item.nome,
              categoria: 'Outros',
              unidade: item.unidade || 'un',
              quantidade: 0,
              estoque_minimo: 0,
            }).select().single()
            produtoId = novo?.id
            criados++
          }

          if (foto.resultado.tipo === 'entrada') {
            if (!produtoId) { erros++; continue }
            await registrarEntrada(produtoId, item.quantidade, 'Importado por foto')
          } else if (foto.resultado.tipo === 'saida_ficha') {
            if (fichaId) await registrarSaidaFicha(fichaId, item.quantidade, 'Importado por foto')
            else if (produtoId) await registrarSaidaManual(produtoId, item.quantidade, 'Importado por foto')
            else { erros++; continue }
          } else {
            if (!produtoId) { erros++; continue }
            await registrarSaidaManual(produtoId, item.quantidade, 'Importado por foto')
          }
          ok++
        } catch { erros++ }
      }
    }

    setConfirmando(false)
    if (ok > 0) {
      const msg = criados > 0 ? `${ok} item(ns) lançado(s)! ${criados} produto(s) criado(s) automaticamente.` : `${ok} item(ns) lançado(s) no estoque!`
      toast.success(msg)
      setFila(prev => prev.filter(f => f.status !== 'pronto'))
    }
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
                      return (
                        <div key={i} className={`border rounded-lg p-2 space-y-2 ${item.ativo ? 'border-gray-200' : 'border-gray-100 opacity-50'}`}>
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox" checked={item.ativo}
                              onChange={e => atualizarItem(foto.id, i, 'ativo', e.target.checked)}
                              className="w-4 h-4 accent-red-600 shrink-0"
                            />
                            <span className="text-sm font-medium text-gray-800 truncate">{item.nome}</span>
                            {!vinculo && <Badge color="red">Sem vínculo</Badge>}
                          </div>
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
