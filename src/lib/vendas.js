// Leitura da planilha de VENDAS ("Itens e Opções") do PDV — SEM IA.
// Formato ANINHADO: cada produto (pai, sem "-") traz o detalhamento logo
// embaixo (filhos com "- "), com o meio-a-meio já contado como 0,5.
//   Pizza Grande = 100
//     - Argentina = 18,5     (sabor; tamanho G vem do pai)
//     - Borda de Catupiry = 10
//   Pizza Pequena = 19
//     - Argentina = 3,5      (mesmo sabor, tamanho P)
//
// Regra de baixa:
//  - Pai GENÉRICO/combo (os filhos não-borda SOMAM o total do pai) → baixa pelos
//    FILHOS, pula o pai (anti-dobra). Ex: Pizza Grande, Pizza Pequena, Diversos.
//  - Pai ESPECÍFICO (filhos < total; são adicionais) → baixa o PAI + os filhos.
//    Ex: Pizza Calabresa G = 9 → 9× Calabresa G + 1 borda + 1 refri.
//  - Item PRONTO (sem filhos) → baixa direto.
//  - Meio-a-meio "X e Y" → dividido em 0,5 de cada ficha (EXATO, sem arredondar).
// O tamanho (G/P) das pizzas vem do nome do pai. Quantidades fracionadas
// (0,5 · 7,5 · 18,5) são preservadas exatamente.

const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n }
const limpa = s => String(s || '').trim()
const semAcento = s => limpa(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Tamanho de um nome de PIZZA: 'G' (grande) | 'P' (pequena) | null (não-pizza).
function tamanhoDoNome(nome) {
  const s = semAcento(nome)
  if (!s.includes('pizza')) return null
  if (/\bgrande\b/.test(s) || /(^|\s)g(\s|$)/.test(s)) return 'G'
  if (/\bpequena\b/.test(s) || /(^|\s)p(\s|$)/.test(s)) return 'P'
  return null
}

// "Pizza 1/2 X e 1/2 Y G" → [{X, q/2}, {Y, q/2}] (0,5 EXATO). null se não casar.
function dividirMeioAMeio(nome, quantidade, tamanho) {
  const limpo = nome.replace(/pizza/ig, ' ').replace(/\s+/g, ' ').trim()
  const m = limpo.match(/1\/2\s+(.+?)\s+e\s+1\/2\s+(.+)/i)
  if (!m) return null
  const tirarTam = s => s.replace(/\s+(g|p|grande|pequena)\s*$/i, '').trim()
  const a = tirarTam(m[1]); const b = tirarTam(m[2])
  if (!a || !b) return null
  const meta = quantidade / 2 // metade pra cada sabor — sem arredondar
  return [
    { nome: a, quantidade: meta, tamanho: tamanho ?? null },
    { nome: b, quantidade: meta, tamanho: tamanho ?? null },
  ]
}

// Recebe as linhas (array de arrays, header:1) e devolve { itens, ignorados }.
//  itens: [{ nome, quantidade, tamanho: 'G'|'P'|null }]  — o que será baixado.
//  ignorados: [{ nome, quantidade }] — pais genéricos pulados (deduzidos pelos filhos).
export function parseVendasRows(rows) {
  const hdr = rows.findIndex(r => semAcento(r[0]).startsWith('itens'))
  const start = hdr >= 0 ? hdr + 1 : 0

  // 1) Monta a árvore pai → filhos.
  const blocos = []
  let cur = null
  for (let i = start; i < rows.length; i++) {
    const c0 = limpa(rows[i][0]); const q = num(rows[i][1])
    if (!c0 || q === null) continue
    if (c0.startsWith('-')) {
      if (cur) cur.filhos.push({ nome: c0.replace(/^-+\s*/, '').trim(), q })
    } else {
      cur = { nome: c0, q, filhos: [] }
      blocos.push(cur)
    }
  }

  const itens = []
  const ignorados = []
  const ehBorda = n => /borda/i.test(n)
  const ehBebida = n => /refriger|coca|guaran|schweppes|\bsoda\b|sprite|fanta|cerveja|chopp|heineken|stella|brahma|antarctica|\bagua\b|\bsuco\b|tonica|\blata\b|\b350\b|\b600\b|\b2\s*l\b|\blitro|jarra|limonada|caipir|\bgin\b|drink|original\s*\d/i.test(n)
  // "Adicional" = não é conteúdo principal (borda ou bebida). NÃO descarta o pai.
  const ehAdicional = n => ehBorda(n) || ehBebida(n)

  const emitir = (nome, quantidade, tamanho) => {
    const tam = tamanho ?? tamanhoDoNome(nome)
    const split = dividirMeioAMeio(nome, quantidade, tam)
    if (split) itens.push(...split)
    else itens.push({ nome, quantidade, tamanho: tam })
  }

  // Tamanho de um FILHO: só recebe G/P se o pai é pizza E o filho é conteúdo
  // (sabor) — não borda/bebida (que casam por nome).
  const tamanhoFilho = (paiNome, filhoNome) => {
    if (!semAcento(paiNome).includes('pizza')) return null
    if (ehAdicional(filhoNome)) return null
    return tamanhoDoNome(paiNome)
  }

  // 2) Decide pai a pai — pelo TIPO dos filhos, NÃO pelo total do pai (descartado).
  for (const b of blocos) {
    const temConteudo = b.filhos.some(f => !ehAdicional(f.nome)) // filho que NÃO é borda/bebida

    if (b.filhos.length && temConteudo) {
      // Container (genérico/combo): a venda são os FILHOS. Descarta o pai.
      // Usa o valor de face dos filhos (sem normalizar pelo total do pai).
      ignorados.push({ nome: b.nome, quantidade: b.q })
      for (const f of b.filhos) emitir(f.nome, f.q, tamanhoFilho(b.nome, f.nome))
    } else {
      // Específico (Pizza Calabresa G…) ou pronto (sem filhos): a venda é o PAI;
      // os filhos (borda/bebida) são adicionais, baixados por nome.
      emitir(b.nome, b.q, tamanhoDoNome(b.nome))
      for (const f of b.filhos) emitir(f.nome, f.q, null)
    }
  }

  return { itens, ignorados }
}

// Lê o arquivo .xlsx (SheetJS lazy, 1ª aba) e aplica parseVendasRows.
export async function lerVendasXlsx(file) {
  const XLSX = await import('xlsx')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' })
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
        resolve(parseVendasRows(rows))
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}
