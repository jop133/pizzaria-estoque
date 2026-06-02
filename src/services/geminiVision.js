const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const MODEL_TEXTO = 'llama-3.3-70b-versatile'

export async function analisarImagemEstoque(imageBase64, mimeType, produtos, fichas, apiKey) {
  const prompt = `Voce transcreve documentos de estoque. Sua UNICA tarefa e ler a imagem e copiar fielmente cada linha. Nao interprete, nao compare com nada, nao some. Apenas transcreva o que esta escrito.

Tipo do documento: "entrada" = nota fiscal ou lista de compras | "saida_ficha" = comanda/pedido | "saida_manual" = descarte | "desconhecido" = outro.

Para CADA linha do documento, sem pular nenhuma:
- nome: o texto do item exatamente como escrito (mantenha o peso se estiver no nome, ex: "MEL 780G").
- quantidade: o numero de unidades do item. Em nota fiscal/DANFE use SOMENTE a coluna QUANTIDADE (ou QTD/QTDE) — NAO use V.UNITARIO, V.TOTAL, NCM, CST nem ICMS. Em tabela manuscrita, o numero da coluna da direita pertence a linha na MESMA altura horizontal. Celula vazia ou "O" = 0. Sem numero visivel = 1.
- pesoEmbalagem: se o nome tiver peso/volume (ex: 780G, 200G, 900ML), o NUMERO (ex: 780). Senao null.
- unidadeEmbalagem: a unidade do peso ("g","kg","ml","l") ou null.
- marca: a marca do fabricante se aparecer, senao null.

Regras: copie TODAS as linhas. Nao converta nem multiplique pesos. Cada linha e um item separado, mesmo que o nome se repita.

Retorne SOMENTE este JSON:
{"tipo":"entrada","descricao":"descricao curta","itens":[{"nome":"texto da linha","quantidade":1,"unidade":"un","pesoEmbalagem":null,"unidadeEmbalagem":null,"marca":null}],"confianca":"alta","observacao":""}`

  const body = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ]
      }
    ],
    max_tokens: 8192,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Erro na API: ${res.status}`)
  }

  const data = await res.json()
  const texto = data.choices?.[0]?.message?.content || ''

  try {
    const resultado = JSON.parse(texto)
    if (!resultado.itens) resultado.itens = []
    if (!resultado.tipo) resultado.tipo = 'desconhecido'
    return resultado
  } catch (e) {
    throw new Error('Erro ao interpretar resposta: ' + texto.slice(0, 200), { cause: e })
  }
}

export async function analisarFichaTecnica(imageBase64, mimeType, produtos, apiKey) {
  const listaProdutos = produtos.map(p => `- ${p.nome} (${p.unidade})`).join('\n')

  const prompt = `Analise a imagem e extraia a ficha tecnica de um prato ou pizza.

Produtos cadastrados no estoque:
${listaProdutos || '(nenhum)'}

Retorne SOMENTE este JSON, sem texto adicional:
{"nome":"nome do prato","categoria":"Pizza","descricao":"descricao opcional","ingredientes":[{"nome":"nome do ingrediente","quantidade":0.1,"unidade":"kg","nomeCadastrado":null}],"confianca":"alta","observacao":""}

Regras:
- Use aspas duplas no JSON
- quantidade deve ser numero
- nomeCadastrado deve ser o nome exato do produto cadastrado acima ou null
- categoria: "Pizza", "Massa", "Molho", "Sobremesa", "Bebida" ou "Outros"
- confianca: "alta", "media" ou "baixa"
- observacao pode ser string vazia`

  const body = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ]
      }
    ],
    max_tokens: 2048,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Erro na API: ${res.status}`)
  }

  const data = await res.json()
  const texto = data.choices?.[0]?.message?.content || ''

  try {
    const resultado = JSON.parse(texto)
    if (!resultado.ingredientes) resultado.ingredientes = []
    return resultado
  } catch (e) {
    throw new Error('Erro ao interpretar resposta: ' + texto.slice(0, 200), { cause: e })
  }
}

// Chamada SÓ DE TEXTO (sem imagem) que agrupa nomes de produtos por tipo,
// ignorando marca/peso/volume. Roda separada da leitura de visão (não afeta a
// precisão dela e usa limites de modelo independentes no Groq).
// Recebe um array de nomes; retorna um mapa { nome: nomeBase }.
// Em qualquer falha, lança erro — o chamador deve tratar com fallback.
export async function agruparPorTipo(nomes, apiKey) {
  const unicos = [...new Set((nomes || []).map(n => (n || '').trim()).filter(Boolean))]
  if (unicos.length === 0) return {}

  const prompt = `Voce agrupa nomes de produtos de estoque por TIPO, ignorando marca, peso, volume e embalagem.
Para cada nome da lista, devolva "nomeBase" = o tipo do produto, sem marca, sem peso e sem volume.
Nomes do MESMO tipo (marcas ou pesos diferentes) devem ter EXATAMENTE o mesmo nomeBase.
Tipos diferentes ficam distintos (ex: "Queijo Mussarela" e diferente de "Queijo Gorgonzola").
Use o mesmo idioma e uma capitalizacao natural (ex: "Queijo Mussarela").

Lista:
${unicos.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Retorne SOMENTE este JSON, com um item para CADA nome da lista:
{"itens":[{"nome":"nome exatamente como na lista","nomeBase":"tipo do produto"}]}`

  const body = {
    model: MODEL_TEXTO,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
    temperature: 0,
    response_format: { type: 'json_object' },
  }

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Erro na API: ${res.status}`)
  }

  const data = await res.json()
  const texto = data.choices?.[0]?.message?.content || ''
  const parsed = JSON.parse(texto)
  const mapa = {}
  for (const it of parsed.itens || []) {
    if (it?.nome && it?.nomeBase) mapa[it.nome.trim()] = it.nomeBase.trim()
  }
  return mapa
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Pré-processa a foto antes de enviar à IA: redimensiona, converte para escala
// de cinza, aumenta o contraste e aplica nitidez (unsharp mask), deixando o
// texto bem mais crocante para a leitura. Retorna { base64, mimeType } PNG
// (sem perdas, preserva as bordas das letras).
// Em caso de qualquer falha, cai de volta no arquivo original.
export async function prepararImagem(file, { maxDimensao = 2200, contraste = 45, nitidez = 0.8 } = {}) {
  try {
    const bitmap = await createImageBitmap(file)
    let { width, height } = bitmap
    const escala = Math.min(1, maxDimensao / Math.max(width, height))
    width = Math.round(width * escala)
    height = Math.round(height * escala)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    const img = ctx.getImageData(0, 0, width, height)
    const d = img.data
    const n = width * height

    // 1) Escala de cinza + contraste -> buffer separado (para a nitidez ler
    //    valores originais sem se contaminar com os já escritos).
    const fator = (259 * (contraste + 255)) / (255 * (259 - contraste))
    const gray = new Float32Array(n)
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      v = fator * (v - 128) + 128
      gray[p] = v < 0 ? 0 : v > 255 ? 255 : v
    }

    // 2) Nitidez (unsharp mask): realça a diferença entre o pixel e a média dos
    //    vizinhos, deixando as bordas das letras mais definidas.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x
        const c = gray[p]
        const up = gray[(y > 0 ? y - 1 : 0) * width + x]
        const down = gray[(y < height - 1 ? y + 1 : height - 1) * width + x]
        const left = gray[y * width + (x > 0 ? x - 1 : 0)]
        const right = gray[y * width + (x < width - 1 ? x + 1 : width - 1)]
        let v = c + nitidez * (c - (up + down + left + right) / 4)
        v = v < 0 ? 0 : v > 255 ? 255 : v
        const idx = p * 4
        d[idx] = d[idx + 1] = d[idx + 2] = v
      }
    }
    ctx.putImageData(img, 0, 0)

    const dataUrl = canvas.toDataURL('image/png')
    return { base64: dataUrl.split(',')[1], mimeType: 'image/png' }
  } catch {
    const base64 = await fileToBase64(file)
    return { base64, mimeType: file.type || 'image/jpeg' }
  }
}
