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

// Reconhece peso/volume escrito de várias formas dentro de um nome de produto:
// g, gr, grs, grama(s), kg, kgs, quilo(s), kilo(s), ml, mililitro(s), l, lt,
// lts, litro(s) — com ou sem espaço (ex: "100 GRAMAS", "200GR", "2,5KG", "900ML").
// A ordem da alternância importa (mais específico antes do genérico).
const VARIANTES_PESO = '(kgs?|quilos?|kilos?|mililitros?|ml|gramas?|grs?|g|litros?|lts?|l)'
const RE_PESO_UM = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${VARIANTES_PESO}\\b`, 'i')
const RE_PESO_TODOS = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${VARIANTES_PESO}\\b`, 'gi')

function canonizarPeso(u) {
  const s = u.toLowerCase()
  if (s[0] === 'k' || s[0] === 'q') return 'kg'
  if (s.startsWith('ml') || s.startsWith('mili')) return 'ml'
  if (s[0] === 'l') return 'l'
  return 'g'
}

// Extrai o primeiro peso/volume de um nome. Retorna { valor, unidade } com a
// unidade canônica (g|kg|ml|l), ou null se não houver.
export function extrairPeso(nome) {
  const m = String(nome || '').match(RE_PESO_UM)
  if (!m) return null
  const valor = parseFloat(m[1].replace(',', '.'))
  if (!valor) return null
  return { valor, unidade: canonizarPeso(m[2]) }
}

// Remove todos os pesos/volumes de um nome (para sugerir um nome "limpo").
export function removerPeso(nome) {
  return String(nome || '').replace(RE_PESO_TODOS, ' ')
}
