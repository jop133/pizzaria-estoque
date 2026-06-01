const OPENROUTER_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

export async function analisarImagemEstoque(imageBase64, mimeType, produtos, fichas, apiKey) {
  const listaProdutos = produtos.map(p => `- ${p.nome} (${p.unidade})`).join('\n')
  const listaFichas = fichas.map(f => `- ${f.nome}`).join('\n')

  const prompt = `Você é um assistente de controle de estoque de uma pizzaria.

Analise esta imagem e identifique se ela contém:
1. Uma NOTA FISCAL ou RECIBO de compra/entrega de ingredientes/produtos
2. Um PEDIDO ou COMANDA com pizzas/pratos vendidos
3. Uma LISTA DE ESTOQUE ou contagem manual de produtos
4. Outro tipo de documento

Produtos cadastrados no estoque:
${listaProdutos || '(nenhum ainda)'}

Fichas técnicas (pratos/pizzas):
${listaFichas || '(nenhuma ainda)'}

Responda APENAS com um JSON válido, sem markdown, sem explicação, no seguinte formato:

{
  "tipo": "entrada" | "saida_ficha" | "saida_manual" | "desconhecido",
  "descricao": "breve descrição do que foi identificado na imagem",
  "itens": [
    {
      "nome": "nome do item identificado",
      "quantidade": número,
      "unidade": "kg|g|L|ml|un|cx|pct",
      "nomeCadastrado": "nome exato do produto/ficha cadastrado ou null se não encontrar correspondência"
    }
  ],
  "confianca": "alta" | "media" | "baixa",
  "observacao": "alguma dúvida ou aviso relevante"
}

Regras:
- Para notas fiscais de compra → tipo "entrada"
- Para comandas/pedidos de pizza → tipo "saida_ficha"
- Para descartes ou uso interno → tipo "saida_manual"
- Tente associar cada item ao produto cadastrado mais próximo pelo nome
- Se não tiver certeza de algum valor, coloque confianca "baixa"`

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
    max_tokens: 1024,
    temperature: 0.1,
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://estoquepier.netlify.app',
      'X-Title': 'Pizzaria Estoque',
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
    const semMarkdown = texto.replace(/```json\n?|\n?```/g, '').trim()
    const match = semMarkdown.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('JSON não encontrado')
    return JSON.parse(match[0])
  } catch {
    throw new Error('Não foi possível interpretar a resposta da IA. Tente novamente.')
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
