const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

export async function analisarImagemEstoque(imageBase64, mimeType, produtos, fichas, apiKey) {
  const prompt = `Voce transcreve documentos de estoque. Sua UNICA tarefa e ler a imagem e copiar fielmente cada linha. Nao interprete, nao compare com nada, nao some. Apenas transcreva o que esta escrito.

Tipo do documento: "entrada" = nota fiscal ou lista de compras | "saida_ficha" = comanda/pedido | "saida_manual" = descarte | "desconhecido" = outro.

Para CADA linha do documento, sem pular nenhuma:
- nome: o texto do item exatamente como escrito (mantenha o peso se estiver no nome, ex: "MEL 780G").
- quantidade: o numero escrito na linha (frascos/pacotes/unidades). Em tabela manuscrita, o numero da coluna da direita pertence a linha na MESMA altura horizontal. Celula vazia ou "O" = 0. Sem numero visivel = 1.
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
