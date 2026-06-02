const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

export async function analisarImagemEstoque(imageBase64, mimeType, produtos, fichas, apiKey) {
  const listaProdutos = produtos.map(p => `- ${p.nome} (${p.unidade})`).join('\n')
  const listaFichas = fichas.map(f => `- ${f.nome}`).join('\n')

  const prompt = `Analise a imagem e retorne um JSON com os itens identificados.

Tipo do documento:
- nota fiscal ou recibo de compra = "entrada"
- comanda ou pedido de vendas = "saida_ficha"
- descarte ou uso interno = "saida_manual"
- outro = "desconhecido"

Produtos cadastrados no estoque:
${listaProdutos || '(nenhum)'}

Fichas tecnicas:
${listaFichas || '(nenhuma)'}

Retorne SOMENTE este JSON, sem texto adicional:
{"tipo":"entrada","descricao":"descricao curta","itens":[{"nome":"nome original na imagem","quantidade":1,"unidade":"kg","nomeCadastrado":null,"marca":null}],"confianca":"alta","observacao":""}

Regras IMPORTANTES:
- Use aspas duplas no JSON
- quantidade deve ser numero
- Liste TODOS os itens encontrados na imagem, independente de estarem cadastrados ou nao
- nome: nome completo como aparece na imagem (ex: "Batata Palito Tio Joao 2kg")
- nomeCadastrado: verifique se o item corresponde a algum produto do estoque acima. Se for o mesmo tipo (ex: "Batata Palito Tio Joao" = "Batata Palito", "Queijo Mussarela Italac" = "Queijo Mussarela"). ATENCAO: tipos diferentes sao produtos distintos (ex: "Queijo Mussarela" != "Queijo Gorgonzola", "Batata Palito" != "Batata Rustica"). Se nao encontrar correspondencia, use null — nao invente correspondencias.
- marca: extraia apenas a marca do fabricante (ex: "Tio Joao", "Italac", "McCain"). Se nao identificar, use null.
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
    throw new Error('Erro ao interpretar resposta: ' + texto.slice(0, 200))
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
    throw new Error('Erro ao interpretar resposta: ' + texto.slice(0, 200))
  }
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
