const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

export async function analisarImagemEstoque(imageBase64, mimeType, produtos, fichas, apiKey) {
  const listaProdutos = produtos.map(p => `- ${p.nome} (${p.unidade})`).join('\n')
  const listaFichas = fichas.map(f => `- ${f.nome}`).join('\n')

  const prompt = `Voce e um leitor de documentos de estoque. Leia a imagem com atencao e extraia TODOS os itens e quantidades visiveis.

PASSO 1 — Classifique o documento:
"entrada" = nota fiscal ou lista de compras | "saida_ficha" = comanda ou pedido | "saida_manual" = descarte | "desconhecido" = outro

PASSO 2 — Liste TODOS os itens da imagem sem excecao. Para tabelas com quantidades escritas a mao na coluna da direita: cada numero pertence a linha que esta na MESMA altura horizontal que ele, nao a linha acima nem abaixo. Se a celula estiver vazia ou com "O" (letra O), a quantidade e 0.

PASSO 3 — Para cada item, verifique se existe correspondencia SEMANTICA na lista abaixo. O produto precisa ser o mesmo tipo (ex: "Batata Palito McCain" = "Batata Palito"). NAO faca correspondencia por substring ou coincidencia parcial de letras (ex: "Molho de Pimenta Vermelha" NAO e "Mel" so porque contem as letras m-e-l). Se nao tiver certeza, use null.

PASSO 4 — Se identificar a marca do fabricante no nome do item, coloque em marca. Caso contrario null.

PASSO 5 — quantidade = o numero contado na imagem (quantos frascos/pacotes/pecas). NAO converta pesos nem multiplique nada, apenas retorne o numero contado. Mantenha no nome o peso da embalagem se houver (ex: "MEL 780G").

Produtos no estoque:
${listaProdutos || '(nenhum)'}

Fichas tecnicas:
${listaFichas || '(nenhuma)'}

Retorne SOMENTE este JSON:
{"tipo":"entrada","descricao":"descricao curta","itens":[{"nome":"nome como na imagem","quantidade":1,"unidade":"un","nomeCadastrado":null,"marca":null}],"confianca":"alta","observacao":""}`

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
