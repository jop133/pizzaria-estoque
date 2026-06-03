// Cálculo de custos de produtos e fichas.
// - Produto comum: usa o preço de custo cadastrado (manual).
// - Produto gerado por ficha de produção: custo = (Σ insumos × custo) / rendimento.
//   (resolve recursivamente, com proteção contra ciclos).

// Retorna uma função memoizada custoUnit(produtoId) -> custo por unidade.
export function criarCalculadoraDeCusto(produtos, fichas, ingredientes) {
  const prodById = {}
  for (const p of produtos) prodById[p.id] = p

  const fichaPorProdutoSaida = {}
  for (const f of fichas) {
    if (f.tipo_ficha === 'producao' && f.produto_saida_id) fichaPorProdutoSaida[f.produto_saida_id] = f
  }

  const ingsPorFicha = {}
  for (const ing of ingredientes) {
    (ingsPorFicha[ing.ficha_id] || (ingsPorFicha[ing.ficha_id] = [])).push(ing)
  }

  const memo = {}
  function custoUnit(produtoId, visitando) {
    if (produtoId == null) return 0
    if (produtoId in memo) return memo[produtoId]
    const visit = visitando || new Set()
    if (visit.has(produtoId)) return 0 // ciclo: evita loop infinito

    const ficha = fichaPorProdutoSaida[produtoId]
    let custo
    if (ficha && ficha.rendimento > 0) {
      visit.add(produtoId)
      const ings = ingsPorFicha[ficha.id] || []
      const total = ings.reduce((s, ing) => s + (ing.quantidade || 0) * custoUnit(ing.produto_id, visit), 0)
      visit.delete(produtoId)
      custo = total / ficha.rendimento
    } else {
      custo = prodById[produtoId]?.preco || 0
    }
    custo = Math.round((custo || 0) * 1000) / 1000
    memo[produtoId] = custo
    return custo
  }

  return custoUnit
}

// É um produto gerado por alguma ficha de produção?
export function ehProdutoDeProducao(produtoId, fichas) {
  return fichas.some(f => f.tipo_ficha === 'producao' && f.produto_saida_id === produtoId)
}

export function formatBRL(valor) {
  return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
