import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'

export function useProdutos() {
  return useLiveQuery(() => db.produtos.orderBy('nome').toArray(), []) ?? []
}

export function useFichas() {
  return useLiveQuery(() => db.fichasTecnicas.orderBy('nome').toArray(), []) ?? []
}

export function useFichaIngredientes(fichaId) {
  return useLiveQuery(
    () => fichaId ? db.fichaIngredientes.where('fichaId').equals(fichaId).toArray() : [],
    [fichaId]
  ) ?? []
}

export function useLancamentos() {
  return useLiveQuery(
    () => db.lancamentos.orderBy('data').reverse().limit(200).toArray(),
    []
  ) ?? []
}

export function useProdutosAbaixoMinimo() {
  return useLiveQuery(
    () => db.produtos.filter(p => p.quantidade <= p.estoqueMinimo).toArray(),
    []
  ) ?? []
}
