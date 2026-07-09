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

// Apelidos/sinônimos do cardápio (aplicados na LEITURA, antes de classificar).
// "Mini pizza" é pierzitta; "Nutella" = sabor Cioccolato. Lista extensível.
const ALIASES = [
  [/mini\s*pizzas?/gi, 'Pierzitta'],
  [/nutella/gi, 'Ciocolatto e Morango'],
  [/\b5\s*queijos/gi, 'Cinco Queijos'],
  // Vínculos nome do PDV → ficha/produto (jul/2026). Cobrem variantes/prefixos.
  [/cannoli\s+de\s+cioccolatto.*/i, 'Cannoli de Nutella'],
  [/cannoli\s+italiano.*/i, 'Cannoli'],
  [/(refrigerante\s+)?soda\s+antar\S*\s+lata\s+350\s*ml/i, 'Sprite Lata 350ML'],
  [/jarra\s+suco\s+laranja/i, 'Jarra De Suco De Laranja'],
  [/suco\s+(natural\s+de\s+laranja|de\s+laranja\s+natural)/i, 'Suco Natural De Laranja'],
  [/batata\s+palha.*/i, 'Adicional De Batata Palha'],
  [/medalh[ãa]o\s+de\s+fil[eé]\s+mignon.*/i, 'Adicional De Medalhão De Filet Mignon'],
  [/santa\s+carolina\s+375\s*ml/i, 'Vinho Tinto Santa Carolina 375ml'],
  [/semifreddo\s+de\s+maracuj[áa]/i, "Passione D'oro"],
  [/(talharim\s+ao\s+molho\s+alfredo\s+com\s+mignon|fil[eé]\s+mignon\s+com\s+talharim\s+ao\s+molho\s+alfredo).*/i, 'Filleto Com Talharim Ao Molho Alfredo'],
  [/gnocchi\s+com\s+tagliata\s+di\s+mignon.*/i, 'Gnocchi Com Mignon / Gnocchi Com Tagliata De Manzo'],
  [/santa\s+helena\s+375\s*ml/i, 'Vinho Santa Helena Cabernet 375ML'],
  [/trident.*/i, 'Trident Menta Envelope'],
  [/(contra\s*fil[eé]\s+blu\s+melt|contrafil[eé]\s+speciale).*/i, 'Contrafilé Speciale'],
  [/picanha\s+brasiliana/i, 'Picanha Brasileira'],
  [/parmegiana\s+de\s+fil[eé]\s+mignon\s*-\s*prato.*/i, 'Parmegiana de Filet Mignon'],
  [/^\s*esperanto\s*$/i, 'Vinho Esperanto 750ML'],
  [/^\s*cosecha\s+tarapac[áa]\s*$/i, 'Vinho Chileno Cosecha Tarapaca Chardonnay Garrafa 750ml'],
  [/polpettone\s+com\s+talharim.*/i, 'Polpettone com Talharim'],
  [/spaghetti\/?\s*talharim\s+ao\s+sugo.*/i, 'Spaghetti ao Sugo'],
  [/caipirinha\s+lim[ãa]o/i, 'Caipirinha de Cachaça'],
  [/lim[ãa]o\s+espremido/i, 'Limão Thaiti'],
  [/chopp.*/i, 'Chopp Brahma Claro Barril 50L'],
  [/vinho\s+tinto\s+do\s+porto/i, 'Vinho do Porto Messias'],
]
const aplicarAliases = nome => ALIASES.reduce((s, [re, sub]) => s.replace(re, sub), String(nome || ''))

// Pais genéricos a IGNORAR (vão pro painel de ignorados; os FILHOS continuam
// sendo baixados). Comparado por semAcento do nome do pai.
const IGNORAR = new Set(['refrigerante lata', 'refrigerante 2 litros', 'combo resenha no pier'])

// Tamanho de um nome de PIZZA: 'G' (grande) | 'P' (pequena) | null (não-pizza).
function tamanhoDoNome(nome) {
  const s = semAcento(nome)
  if (!s.includes('pizza')) return null
  if (/\bgrande\b/.test(s) || /(^|\s)g(\s|$)/.test(s)) return 'G'
  if (/\bpequen[ao]\b/.test(s) || /(^|\s)p(\s|$)/.test(s)) return 'P' // pequena E pequeno
  return null
}

// Combos "Diversos - ..." em texto livre: extrai as PIZZAS (pode ter várias,
// separadas por "+" ou numa lista entre parênteses, com número e tamanho por
// pizza). Retorna [{ nome, n, tam }] ou null se o combo não tem pizza.
function segmentosPizzaCombo(nome) {
  if (!/pizza/i.test(nome)) return null
  let s = nome.replace(/^diversos\s*-\s*/i, '')
  const par = s.match(/\(([^)]*pizza[^)]*)\)/i) // lista entre parênteses (RESENHA/SELEÇÃO)
  if (par) s = par[1]
  const tamGlobal = tamanhoDoNome(nome)
  const segs = s.split('+').map(x => x.trim()).filter(x => /pizza/i.test(x))
  if (!segs.length) return null
  return segs.map(seg => {
    const numM = seg.match(/(\d+)\s*pizza/i)
    const n = numM ? parseInt(numM[1], 10) : 1
    const tam = tamanhoDoNome(seg) || tamGlobal
    const nomeSeg = seg
      .replace(/(\d+)\s*pizza/i, 'pizza')
      .replace(/\([^)]*\)/g, ' ')      // tira "(Pequeno)" etc
      .replace(/-?\s*\d+\s*cm/gi, ' ')  // tira "- 28 cm"
      .replace(/\s+/g, ' ').trim()
    return { nome: nomeSeg, n, tam }
  })
}

// Combos de PIERZITTA em texto livre (lista por vírgula/"e", às vezes em "()").
// Ex: "SELEÇÃO PIER ( 1 Pierzitta Calabresa, 1 Pierzitta margherita, ...)" ou
// "Seleção-5 Pierzittas Calabresa,Argentina,...". Retorna [{nome,n}] ou null.
function segmentosPierzittaCombo(nome) {
  const s = semAcento(nome)
  const ehCombo = /selecao/.test(s) || (s.match(/pierzitta/g) || []).length > 1 || (s.includes(',') && /pierzitta/.test(s))
  if (!ehCombo) return null
  const par = nome.match(/\(([^)]+)\)/)
  const lista = par ? par[1] : nome.replace(/^.*pierzittas?/i, '')
  const out = []
  for (const p of lista.split(/,|\be\b|\+/i).map(x => x.trim()).filter(Boolean)) {
    const numM = p.match(/(\d+)\s*pierzitta/i)
    const n = numM ? parseInt(numM[1], 10) : 1
    const flavor = p.replace(/\d+/g, '').replace(/pierzittas?/ig, '').replace(/\./g, '').replace(/\s+/g, ' ').trim()
    if (flavor && !/refri|lata|coca|guaran|350|refrigerante|schweppes|soda/i.test(flavor)) {
      out.push({ nome: 'Pierzitta ' + flavor, n })
    }
  }
  return out.length ? out : null
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
  const tam = tamanho || 'G' // meio-a-meio sem tamanho no combo → assume G (mais comum)
  return [
    { nome: a, quantidade: meta, tamanho: tam },
    { nome: b, quantidade: meta, tamanho: tam },
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
    const c0 = aplicarAliases(limpa(rows[i][0])); const q = num(rows[i][1])
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
  // "Adicional" = não é conteúdo principal (borda, bebida ou item marcado como
  // "Adicional ..."). NÃO descarta o pai e NÃO recebe tamanho de pizza.
  const ehAdicional = n => ehBorda(n) || ehBebida(n) || /^adicional/i.test(n)

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
    // Pai genérico a ignorar (ex: "Refrigerante Lata"): não emite o pai (vai pros
    // ignorados), mas mantém os filhos (os sabores reais) sendo baixados.
    if (IGNORAR.has(semAcento(b.nome))) {
      ignorados.push({ nome: b.nome, quantidade: b.q })
      for (const f of b.filhos) emitir(f.nome, f.q, tamanhoFilho(b.nome, f.nome))
      continue
    }

    const temConteudo = b.filhos.some(f => !ehAdicional(f.nome)) // filho que NÃO é borda/bebida

    if (b.filhos.length && temConteudo) {
      // Container (genérico/combo): a venda são os FILHOS. Descarta o pai.
      // Usa o valor de face dos filhos (sem normalizar pelo total do pai).
      ignorados.push({ nome: b.nome, quantidade: b.q })
      for (const f of b.filhos) emitir(f.nome, f.q, tamanhoFilho(b.nome, f.nome))
    } else {
      // Específico (Pizza Calabresa G…), combo "Diversos - …" ou pronto.
      const segs = segmentosPierzittaCombo(b.nome) || segmentosPizzaCombo(b.nome)
      if (segs) {
        // Combo (pierzitta ou pizza): emite cada item, × qtd do combo.
        for (const sg of segs) emitir(sg.nome, sg.n * b.q, sg.tam ?? null)
      } else if (/\+/.test(b.nome)) {
        // Combo NÃO-pizza (ex: "Spaghetti + Coca Grátis"): separa no "+".
        const limpo = b.nome.replace(/^diversos\s*-\s*/i, '')
        for (const seg of limpo.split('+').map(x => x.trim()).filter(Boolean)) emitir(seg, b.q, tamanhoDoNome(seg))
      } else {
        // Prato/item: tira o prefixo "Diversos -" e casa pelo nome.
        emitir(b.nome.replace(/^diversos\s*-\s*/i, '').trim(), b.q, tamanhoDoNome(b.nome))
      }
      // Filhos (borda/bebida) são adicionais, baixados por nome.
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
