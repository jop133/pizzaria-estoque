import { useState, useRef } from 'react'
import { useProdutos, useFichas } from '../hooks/useEstoque'
import { analisarImagemEstoque, fileToBase64 } from '../services/geminiVision'
import { registrarEntrada, registrarSaidaManual, registrarSaidaFicha } from '../services/estoque'
import { db } from '../db'
import { Modal } from '../components/Modal'
import { Badge } from '../components/Badge'
import toast from 'react-hot-toast'

export function ImportarFoto() {
  const produtos = useProdutos()
  const fichas = useFichas()

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '')
  const [editandoChave, setEditandoChave] = useState(!localStorage.getItem('gemini_api_key'))
  const [chaveTemp, setChaveTemp] = useState('')

  const [imagem, setImagem] = useState(null) // { url, file }
  const [analisando, setAnalisando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [itensEditados, setItensEditados] = useState([])
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

  function selecionarArquivo(e) {
    const file = e.target.files[0]
    if (!file) return
    setImagem({ url: URL.createObjectURL(file), file })
    setResultado(null)
    e.target.value = ''
  }

  async function analisar() {
    if (!imagem) return toast.error('Selecione uma imagem primeiro')
    if (!apiKey) return toast.error('Configure a chave da API primeiro')

    setAnalisando(true)
    try {
      const base64 = await fileToBase64(imagem.file)
      const mimeType = imagem.file.type || 'image/jpeg'
      const res = await analisarImagemEstoque(base64, mimeType, produtos, fichas, apiKey)
      setResultado(res)
      setItensEditados(res.itens.map(item => ({
        ...item,
        ativo: true,
        produtoId: encontrarProdutoId(item.nomeCadastrado, item.nome),
        fichaId: encontrarFichaId(item.nomeCadastrado, item.nome),
      })))
    } catch (e) {
      toast.error(e.message || 'Erro ao analisar imagem')
    } finally {
      setAnalisando(false)
    }
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

  async function confirmar() {
    const ativos = itensEditados.filter(i => i.ativo)
    if (ativos.length === 0) return toast.error('Nenhum item selecionado')

    setConfirmando(true)
    let ok = 0
    let erros = 0

    for (const item of ativos) {
      try {
        if (resultado.tipo === 'entrada') {
          if (!item.produtoId) { erros++; continue }
          await registrarEntrada(item.produtoId, item.quantidade, `Importado por foto`)
        } else if (resultado.tipo === 'saida_ficha') {
          if (item.fichaId) {
            await registrarSaidaFicha(item.fichaId, item.quantidade, `Importado por foto`)
          } else if (item.produtoId) {
            await registrarSaidaManual(item.produtoId, item.quantidade, `Importado por foto`)
          } else { erros++; continue }
        } else {
          if (!item.produtoId) { erros++; continue }
          await registrarSaidaManual(item.produtoId, item.quantidade, `Importado por foto`)
        }
        ok++
      } catch { erros++ }
    }

    setConfirmando(false)
    if (ok > 0) toast.success(`${ok} item(ns) lançado(s) no estoque!`)
    if (erros > 0) toast.error(`${erros} item(ns) não puderam ser lançados (produto não encontrado)`)
    if (ok > 0) { setImagem(null); setResultado(null); setItensEditados([]) }
  }

  const tipoLabel = { entrada: 'Entrada / Recebimento', saida_ficha: 'Saída por Ficha', saida_manual: 'Saída Manual', desconhecido: 'Não identificado' }
  const tipoCor = { entrada: 'green', saida_ficha: 'orange', saida_manual: 'red', desconhecido: 'gray' }

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-800">Importar por Foto</h1>

      {/* Configuração da chave */}
      {editandoChave ? (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-blue-800">🔑 Configure sua chave Gemini (gratuita)</p>
          <p className="text-xs text-blue-600">
            Obtenha em: <span className="font-mono">aistudio.google.com/apikey</span>
          </p>
          <input
            className="input"
            placeholder="AIzaSy..."
            value={chaveTemp}
            onChange={e => setChaveTemp(e.target.value)}
          />
          <button onClick={salvarChave} className="btn-primary w-full">Salvar Chave</button>
        </div>
      ) : (
        <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <p className="text-sm text-green-700 font-medium">✅ API Gemini configurada</p>
          <button
            onClick={() => { setChaveTemp(apiKey); setEditandoChave(true) }}
            className="text-xs text-green-600 underline"
          >
            Alterar
          </button>
        </div>
      )}

      {/* Seleção de imagem */}
      <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 text-center space-y-3">
        {imagem ? (
          <div className="space-y-3">
            <img src={imagem.url} alt="Imagem selecionada" className="max-h-64 mx-auto rounded-lg object-contain" />
            <button onClick={() => { setImagem(null); setResultado(null) }} className="text-xs text-red-500 underline">Remover</button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-4xl">📷</p>
            <p className="text-sm text-gray-500">Nota fiscal, comanda, lista de estoque...</p>
          </div>
        )}
        <div className="flex gap-2 justify-center flex-wrap">
          <button onClick={() => fileRef.current.click()} className="btn-secondary text-sm">📁 Escolher arquivo</button>
          <button onClick={() => cameraRef.current.click()} className="btn-secondary text-sm">📷 Tirar foto</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={selecionarArquivo} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={selecionarArquivo} />
      </div>

      {imagem && !resultado && (
        <button
          onClick={analisar}
          disabled={analisando || !apiKey}
          className="btn-primary w-full disabled:opacity-50"
        >
          {analisando ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Analisando imagem...
            </span>
          ) : '🔍 Analisar com IA'}
        </button>
      )}

      {/* Resultado */}
      {resultado && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="font-semibold text-gray-800">Resultado da análise</p>
              <p className="text-sm text-gray-500 mt-0.5">{resultado.descricao}</p>
            </div>
            <div className="flex gap-2 items-center">
              <Badge color={tipoCor[resultado.tipo]}>{tipoLabel[resultado.tipo]}</Badge>
              <Badge color={resultado.confianca === 'alta' ? 'green' : resultado.confianca === 'media' ? 'yellow' : 'red'}>
                Confiança {resultado.confianca}
              </Badge>
            </div>
          </div>

          {resultado.observacao && (
            <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
              ⚠️ {resultado.observacao}
            </p>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-500 uppercase">Itens identificados — confirme antes de lançar</p>
            {itensEditados.map((item, i) => {
              const produtoVinculado = produtos.find(p => p.id === item.produtoId)
              const fichaVinculada = fichas.find(f => f.id === item.fichaId)
              const vinculo = fichaVinculada || produtoVinculado
              const semVinculo = !vinculo

              return (
                <div key={i} className={`border rounded-lg p-3 space-y-2 ${item.ativo ? 'border-gray-200' : 'border-gray-100 opacity-50'}`}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={item.ativo}
                      onChange={e => setItensEditados(prev => prev.map((it, j) => j === i ? { ...it, ativo: e.target.checked } : it))}
                      className="w-4 h-4 accent-red-600"
                    />
                    <span className="font-medium text-gray-800 text-sm">{item.nome}</span>
                    {semVinculo && <Badge color="red">Sem correspondência</Badge>}
                  </div>

                  <div className="grid grid-cols-2 gap-2 ml-6">
                    <div>
                      <label className="label">Quantidade</label>
                      <input
                        type="number" min="0.001" step="0.001"
                        className="input text-sm"
                        value={item.quantidade}
                        onChange={e => setItensEditados(prev => prev.map((it, j) => j === i ? { ...it, quantidade: parseFloat(e.target.value) || 0 } : it))}
                      />
                    </div>
                    <div>
                      <label className="label">
                        {resultado.tipo === 'saida_ficha' ? 'Vincular Ficha/Produto' : 'Vincular Produto'}
                      </label>
                      {resultado.tipo === 'saida_ficha' ? (
                        <select
                          className="input text-sm"
                          value={item.fichaId ?? item.produtoId ?? ''}
                          onChange={e => {
                            const val = parseInt(e.target.value)
                            const isFicha = fichas.some(f => f.id === val)
                            setItensEditados(prev => prev.map((it, j) => j === i ? {
                              ...it,
                              fichaId: isFicha ? val : null,
                              produtoId: isFicha ? null : val,
                            } : it))
                          }}
                        >
                          <option value="">-- não vincular --</option>
                          <optgroup label="Fichas Técnicas">
                            {fichas.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
                          </optgroup>
                          <optgroup label="Produtos">
                            {produtos.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
                          </optgroup>
                        </select>
                      ) : (
                        <select
                          className="input text-sm"
                          value={item.produtoId ?? ''}
                          onChange={e => setItensEditados(prev => prev.map((it, j) => j === i ? { ...it, produtoId: parseInt(e.target.value) || null } : it))}
                        >
                          <option value="">-- não vincular --</option>
                          {produtos.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
                        </select>
                      )}
                    </div>
                  </div>

                  {vinculo && (
                    <p className="ml-6 text-xs text-green-600">
                      ✓ Vinculado a: <strong>{vinculo.nome}</strong>
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          <button
            onClick={confirmar}
            disabled={confirmando}
            className="btn-primary w-full disabled:opacity-50"
          >
            {confirmando ? 'Lançando...' : `✅ Confirmar e Lançar ${itensEditados.filter(i => i.ativo).length} item(ns)`}
          </button>
        </div>
      )}
    </div>
  )
}
