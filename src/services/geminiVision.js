const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const MODEL_TEXTO = 'llama-3.3-70b-versatile'

// Prompt de leitura específico para a finalidade escolhida pelo usuário.
// 'entrada' mantém EXATAMENTE o prompt afinado original.
function montarPromptLeitura(tipo) {
  if (tipo === 'saida_ficha') {
    return `Voce le uma COMANDA ou PEDIDO DE VENDA de uma pizzaria/restaurante (itens vendidos ao cliente). Liste cada prato/item vendido e quantos foram vendidos. Nao invente itens.

Para CADA linha/pedido:
- nome: o nome do prato/item exatamente como escrito (ex: "Pizza Calabresa G", "Refrigerante Lata").
- quantidade: quantos foram vendidos (numero). Sem numero visivel = 1.
- unidade: "un".
- pesoEmbalagem, unidadeEmbalagem e marca: sempre null.

Regras: leia TODAS as linhas, sem pular nem inventar. Cada linha e um item.

Retorne SOMENTE este JSON:
{"tipo":"saida_ficha","descricao":"descricao curta","itens":[{"nome":"texto da linha","quantidade":1,"unidade":"un","pesoEmbalagem":null,"unidadeEmbalagem":null,"marca":null}],"confianca":"alta","observacao":""}`
  }

  if (tipo === 'saida_manual') {
    return `Voce le uma LISTA DE DESCARTE ou USO INTERNO de produtos do estoque (itens retirados, perdidos ou consumidos). Liste cada produto e a quantidade retirada. Nao invente itens.

Para CADA linha:
- nome: o nome do produto como escrito (mantenha o peso se estiver no nome, ex: "MEL 780G").
- quantidade: o numero retirado/descartado. Celula vazia ou "O" = 0. Sem numero visivel = 1. Se for peso direto (ex: 1,5 KG), a quantidade e o proprio peso.
- unidade: a medida (un, pct, cx, dz, kg, g, l, ml). Para peso direto use a unidade de peso. Se nao houver, "un".
- pesoEmbalagem: SOMENTE se o NOME tiver o peso/volume da embalagem (ex: "MEL 780G"), o NUMERO. Senao null.
- unidadeEmbalagem: a unidade do peso da embalagem ("g","kg","ml","l") ou null.
- marca: null.

Regras: leia TODAS as linhas, sem pular nem inventar. Nao multiplique pesos.

Retorne SOMENTE este JSON:
{"tipo":"saida_manual","descricao":"descricao curta","itens":[{"nome":"texto da linha","quantidade":1,"unidade":"un","pesoEmbalagem":null,"unidadeEmbalagem":null,"marca":null}],"confianca":"alta","observacao":""}`
  }

  // entrada (padrão) — IDÊNTICO ao prompt original afinado
  return `Voce transcreve documentos de estoque. Sua UNICA tarefa e ler a imagem e copiar fielmente cada linha. Nao interprete, nao compare com nada, nao some. Apenas transcreva o que esta escrito.

Tipo do documento: "entrada" = nota fiscal ou lista de compras | "saida_ficha" = comanda/pedido | "saida_manual" = descarte | "desconhecido" = outro.

Para CADA linha do documento, sem pular nenhuma:
- nome: o texto do item exatamente como escrito (mantenha o peso se estiver no nome, ex: "MEL 780G").
- quantidade: o numero de unidades do item. Em nota fiscal/DANFE use SOMENTE a coluna QUANTIDADE (ou QTD/QTDE) — NAO use V.UNITARIO, V.TOTAL, NCM, CST nem ICMS. Em tabela manuscrita, o numero da coluna da direita pertence a linha na MESMA altura horizontal. Celula vazia ou "O" = 0. Sem numero visivel = 1.
- unidade: a unidade/medida do item como aparece (ex: un, pct, cx, dz, kg, g, l, ml). Se for vendido por peso direto (ex: carne 5,466 KG), use a unidade de peso (kg/g/l/ml) e a quantidade e o proprio peso. Se nao houver, "un".
- pesoEmbalagem: SOMENTE se o NOME do item tiver o peso/volume da embalagem (ex: "MEL 780G", "OLEO 900ML"), o NUMERO (ex: 780). Se o peso for a quantidade comprada (coluna), deixe null.
- unidadeEmbalagem: a unidade do peso da embalagem ("g","kg","ml","l") ou null.
- marca: a marca do fabricante se aparecer, senao null.

Regras: leia TODAS as linhas, sem pular nenhuma e sem inventar itens que nao existem. Nao converta nem multiplique pesos. Cada linha e um item separado, mesmo que o nome se repita.

Retorne SOMENTE este JSON:
{"tipo":"entrada","descricao":"descricao curta","itens":[{"nome":"texto da linha","quantidade":1,"unidade":"un","pesoEmbalagem":null,"unidadeEmbalagem":null,"marca":null}],"confianca":"alta","observacao":""}`
}

export async function analisarImagemEstoque(imageBase64, mimeType, produtos, fichas, apiKey, tipo = 'entrada') {
  const prompt = montarPromptLeitura(tipo)

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
    max_tokens: 4096,
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

export async function analisarFichaTecnica(imageBase64, mimeType, produtos, apiKey, tipo = 'prato') {
  const listaProdutos = produtos.map(p => `- ${p.nome} (${p.unidade})`).join('\n')

  const prompt = tipo === 'producao'
    ? `Analise a imagem e extraia uma FICHA TECNICA DE PRODUCAO: a receita de fabricacao de um item feito na cozinha (ex: massa, molho, recheio, base). O resultado e UM produto produzido, a partir de insumos.

Produtos cadastrados no estoque:
${listaProdutos || '(nenhum)'}

Retorne SOMENTE este JSON, sem texto adicional:
{"nome":"nome do item produzido","unidade":"kg","rendimento":1,"descricao":"descricao opcional","ingredientes":[{"nome":"nome do insumo","quantidade":0.1,"unidade":"kg","nomeCadastrado":null}],"confianca":"alta","observacao":""}

Regras:
- nome: o produto que a receita PRODUZ (o resultado final), nao um insumo.
- unidade: a unidade do produto produzido — use SOMENTE "kg", "g", "l" ou "ml".
- rendimento: quanto a receita rende no total (numero, na unidade acima). Se nao houver, 1.
- ingredientes: cada insumo com quantidade (numero) e unidade. nomeCadastrado = nome exato de um produto da lista acima, ou null.
- Use aspas duplas no JSON. confianca: "alta", "media" ou "baixa". observacao pode ser vazia.`
    : `Analise a imagem e extraia a ficha tecnica de um prato ou pizza.

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

// Lê uma LISTA DE PRODUÇÃO DE PORCIONADOS (tabela PRODUTO + MEDIDA). Cada linha
// é um porcionado: nome + medida da porção. Retorna { itens: [{nome, medida, unidade}] }.
export async function analisarPorcionados(imageBase64, mimeType, apiKey) {
  const prompt = `Voce le uma LISTA DE PRODUCAO DE PORCIONADOS de uma pizzaria. E uma tabela com a coluna PRODUTO (nome) e a coluna MEDIDA (o tamanho da porcao, ex: "50G", "120 G", "450 G", "KG", "1,5 L", "LITRO"). Para CADA linha de produto:
- nome: o nome do produto exatamente como escrito (ex: "Abacaxi", "Bacon Pronto Cubos").
- medida: o NUMERO da medida (ex: 50 de "50G"; 1,5 de "1,5 L"). Se nao houver numero (so "KG" ou "LITRO"), use null.
- unidade: a unidade da medida ("g","kg","ml","l"). Se nao der pra saber, null.

Ignore titulos e cabecalhos (ex: "PRODUCAO PIZZARIA", mes/ano, dias da semana, "PRODUTO", "MEDIDA"). Leia TODAS as linhas de produto, sem pular nem inventar.

Retorne SOMENTE este JSON:
{"itens":[{"nome":"texto","medida":50,"unidade":"g"}]}`

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
    max_tokens: 4096,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
    if (!Array.isArray(resultado.itens)) resultado.itens = []
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

  const prompt = `Para cada nome da lista, gere um "nomeBase" = o MESMO nome do produto, apenas REMOVENDO marca, peso, volume e embalagem. Nada mais.

REGRA CRITICA: nomeBase NAO e categoria. NUNCA agrupe produtos diferentes sob um nome geral.
- ERRADO: "Mamao", "Maca", "Limao" -> "Frutas". CERTO: continuam "Mamao", "Maca", "Limao" (cada um o seu).
- ERRADO: "Coxa de Frango", "Peito de Frango" -> "Frango". CERTO: "Coxa de Frango" e "Peito de Frango" (distintos).
- ERRADO: "Detergente", "Sabao em Po", "Agua Sanitaria" -> "Limpeza". CERTO: cada um o seu.

So use o MESMO nomeBase para dois itens quando forem REALMENTE o mesmo produto, mudando apenas a marca/peso/embalagem:
- "Queijo Mussarela Tirolez 1kg" e "Queijo Mussarela Polenghi 500g" -> ambos "Queijo Mussarela".
- "Coca-Cola 2L" e "Coca-Cola Lata 350ml" -> ambos "Coca-Cola".
- "Queijo Mussarela" e "Queijo Gorgonzola" -> DISTINTOS (sao tipos diferentes de queijo).

Na duvida, NAO agrupe: mantenha o nome do item praticamente como esta (so tirando marca/peso). E melhor deixar separado do que juntar errado.

Lista:
${unicos.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Retorne SOMENTE este JSON, com um item para CADA nome da lista:
{"itens":[{"nome":"nome exatamente como na lista","nomeBase":"nome sem marca/peso"}]}`

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

// Leitura de uma FOLHA DE CONTAGEM de estoque (lista impressa de produtos com a
// quantidade contada escrita à mão na coluna da direita). Uma chamada de visão
// por foto. O vínculo com os produtos e a soma das marcas é feito depois, em JS
// (lib/matching.js) — aqui só transcrevemos linha a linha.
export async function analisarContagem(imageBase64, mimeType, apiKey) {
  const prompt = `Voce le uma FOLHA DE CONTAGEM DE ESTOQUE de uma pizzaria. E uma tabela: a ESQUERDA tem o nome do produto (impresso) e a unidade; a DIREITA tem a QUANTIDADE CONTADA, normalmente escrita A MAO. Sua tarefa e transcrever cada linha fielmente. Nao interprete, nao some, nao agrupe.

Para CADA linha de produto (ignore titulos/cabecalhos como "CONTROLE DE ESTOQUE", "INSUMOS", "UNIDADE"):
- nome: o nome do produto exatamente como impresso, incluindo peso/volume se fizer parte do nome (ex: "BATATA PALITO ONE FRY PACOTE 2,5 KG", "MEL 780G", "MOLHO SHOYU 500 ML").
- quantidade: o NUMERO escrito a mao na coluna da direita daquela MESMA linha. Celula vazia, riscada ou "O"/"o" = 0. Um numero decimal escrito (ex: "0,500", "2,980") deve ser lido como esta. Sem numero visivel = 0.
- unidade: a unidade impressa da linha (PACOTE, BALDE, BISNAGA, UNIDADE, POTE, KG, etc.). Se nao houver, "un".
- pesoEmbalagem: SOMENTE se o NOME tiver o peso/volume da embalagem (ex: "2,5" de "PACOTE 2,5 KG"), o NUMERO. Senao null.
- unidadeEmbalagem: a unidade desse peso ("kg","g","ml","l") ou null.

Regras: leia TODAS as linhas, de cima a baixo, sem pular nem inventar. O numero da direita pertence a linha na MESMA altura horizontal. Nao multiplique nem converta pesos.

Retorne SOMENTE este JSON:
{"itens":[{"nome":"texto da linha","quantidade":0,"unidade":"un","pesoEmbalagem":null,"unidadeEmbalagem":null}],"observacao":""}`

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
    max_tokens: 4096,
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
    if (!Array.isArray(resultado.itens)) resultado.itens = []
    return resultado
  } catch (e) {
    throw new Error('Erro ao interpretar resposta: ' + texto.slice(0, 200), { cause: e })
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Chamada de texto ao Groq com 1 retentativa em caso de rate limit (429),
// respeitando o tempo sugerido pela API ("try again in Xs").
async function chamarGroqTexto(prompt, apiKey, maxTokens) {
  const body = {
    model: MODEL_TEXTO,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0,
    response_format: { type: 'json_object' },
  }
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (res.status === 429) {
      const err = await res.json().catch(() => ({}))
      const m = (err?.error?.message || '').match(/try again in ([\d.]+)s/i)
      const espera = m ? Math.ceil(parseFloat(m[1]) * 1000) + 800 : 15000
      await sleep(Math.min(espera, 65000))
      continue
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Erro na API: ${res.status}`)
    }
    const data = await res.json()
    return JSON.parse(data.choices?.[0]?.message?.content || '{}')
  }
  throw new Error('Limite de uso da IA atingido. Aguarde 1 minuto e tente de novo.')
}

// Classifica produtos do estoque em categorias usando o modelo de texto.
// Lotes pequenos + saída compacta (só as categorias, na ordem) para caber no
// limite de tokens por minuto do Groq. `onProgresso(lote, total)` é opcional.
export async function categorizarProdutos(nomes, categorias, apiKey, onProgresso) {
  const unicos = [...new Set((nomes || []).map(n => (n || '').trim()).filter(Boolean))]
  const mapa = {}
  if (unicos.length === 0) return mapa

  const TAM = 50
  const lotes = []
  for (let i = 0; i < unicos.length; i += TAM) lotes.push(unicos.slice(i, i + TAM))

  for (let l = 0; l < lotes.length; l++) {
    if (onProgresso) onProgresso(l + 1, lotes.length)
    const lote = lotes[l]
    const prompt = `Classifique cada produto de estoque de uma pizzaria em UMA destas categorias EXATAS (copie igual, com acentos):
${categorias.join(' | ')}

Entenda o SIGNIFICADO (nao so a palavra). Guia:
- Hortifruti: SO produtos frescos/in natura (frutas, legumes, verduras, ervas frescas). Ex: "Batata Branca Lavada", "Tomate", "Alface", "Cebola".
- Mercearia: secos, enlatados, congelados e INDUSTRIALIZADOS embalados. ATENCAO: batata ja processada vai aqui — "Batata Palito", "Batata Palha" sao industrializadas = Mercearia, NAO Hortifruti. Tambem: farinha, acucar, oleo, azeite, molho de tomate, massa seca, tempero, conserva, mel, enlatado.
- Laticinios e Frios: queijo, mussarela, catupiry, requeijao, creme de leite, manteiga, leite, iogurte, frios fatiados (presunto, mortadela).
- Proteinas: carnes, frango, linguica, bacon, peixe, camarao, ovos, hamburguer.
- Producoes Internas: feito na propria cozinha (massa/molho caseiro, recheio, base).
- Bebidas: refrigerante, suco, agua, cerveja, vinho, energetico, destilado.
- Limpeza: PRODUTOS QUIMICOS de limpeza/higiene — detergente, sabao, agua sanitaria, alcool, desinfetante, multiuso, amaciante, esponja, pano de limpeza, saco de lixo.
- Embalagens e Etiquetas: itens DESCARTAVEIS de embalar/servir (nao quimicos) — saco plastico, bandeja, pote, copo, talher descartavel, papel toalha, guardanapo, filme plastico, papel aluminio, etiqueta, fita, marmita.
- Porcionados: produtos ja porcionados em porcoes individuais (nome com "porcionado"/"porcao").
- Outros: so quando realmente nao se encaixa.

Produtos (responda na MESMA ORDEM, exatamente ${lote.length} itens):
${lote.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Retorne SOMENTE este JSON: {"categorias":["categoria do item 1","categoria do item 2", ...]}`

    const maxTokens = Math.min(2048, lote.length * 12 + 200)
    const parsed = await chamarGroqTexto(prompt, apiKey, maxTokens)
    const cats = Array.isArray(parsed.categorias) ? parsed.categorias : []
    for (let i = 0; i < lote.length && i < cats.length; i++) {
      const c = (cats[i] || '').trim()
      if (c) mapa[lote[i]] = c
    }
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
// texto bem mais crocante para a leitura. Retorna { base64, mimeType } JPEG
// em qualidade alta (mantém nitidez com upload bem mais leve que PNG).
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

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    return { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' }
  } catch {
    const base64 = await fileToBase64(file)
    return { base64, mimeType: file.type || 'image/jpeg' }
  }
}
