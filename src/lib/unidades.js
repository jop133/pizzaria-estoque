// Conversão entre unidades de peso/volume.
// g≡ml e kg≡l usam aproximação de densidade 1 (padrão de cozinha).
// Unidades fora desta tabela (un, cx, pct, fardo...) não convertem.
const BASE = { g: 1, ml: 1, kg: 1000, l: 1000 }

// Fator para converter de uma unidade para outra. 1 quando não há conversão
// possível (mesma unidade, ou unidades não conversíveis entre si).
export function fatorUnidade(de, para) {
  const d = (de || '').toLowerCase()
  const p = (para || '').toLowerCase()
  if (!d || !p || d === p) return 1
  if (BASE[d] && BASE[p]) return BASE[d] / BASE[p]
  return 1
}

// Converte uma quantidade de uma unidade para outra (arredonda em 3 casas).
export function converterUnidade(qtd, de, para) {
  const n = parseFloat(qtd)
  if (isNaN(n)) return qtd
  return Math.round(n * fatorUnidade(de, para) * 1000) / 1000
}
