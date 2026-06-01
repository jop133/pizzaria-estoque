import Dexie from 'dexie'

export const db = new Dexie('PizzariaEstoque')

db.version(1).stores({
  produtos: '++id, nome, categoria, unidade, quantidade, estoqueMinimo',
  fichasTecnicas: '++id, nome, categoria',
  fichaIngredientes: '++id, fichaId, produtoId, quantidade',
  lancamentos: '++id, tipo, data, fichaId, produtoId, quantidade, observacao',
})

// tipo lancamento: 'saida_ficha' | 'saida_manual' | 'entrada'
