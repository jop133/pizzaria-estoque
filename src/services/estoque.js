import { db } from '../db'

export async function registrarSaidaFicha(fichaId, quantidade, observacao = '') {
  const ficha = await db.fichasTecnicas.get(fichaId)
  if (!ficha) throw new Error('Ficha não encontrada')

  const ingredientes = await db.fichaIngredientes.where('fichaId').equals(fichaId).toArray()

  await db.transaction('rw', db.produtos, db.lancamentos, async () => {
    for (const ing of ingredientes) {
      const totalGasto = ing.quantidade * quantidade
      const produto = await db.produtos.get(ing.produtoId)
      if (!produto) continue
      await db.produtos.update(ing.produtoId, {
        quantidade: Math.max(0, produto.quantidade - totalGasto)
      })
    }
    await db.lancamentos.add({
      tipo: 'saida_ficha',
      fichaId,
      nomeFicha: ficha.nome,
      quantidade,
      data: new Date().toISOString(),
      observacao,
    })
  })
}

export async function registrarSaidaManual(produtoId, quantidade, observacao = '') {
  const produto = await db.produtos.get(produtoId)
  if (!produto) throw new Error('Produto não encontrado')

  await db.transaction('rw', db.produtos, db.lancamentos, async () => {
    await db.produtos.update(produtoId, {
      quantidade: Math.max(0, produto.quantidade - quantidade)
    })
    await db.lancamentos.add({
      tipo: 'saida_manual',
      produtoId,
      nomeProduto: produto.nome,
      quantidade,
      data: new Date().toISOString(),
      observacao,
    })
  })
}

export async function registrarEntrada(produtoId, quantidade, observacao = '') {
  const produto = await db.produtos.get(produtoId)
  if (!produto) throw new Error('Produto não encontrado')

  await db.transaction('rw', db.produtos, db.lancamentos, async () => {
    await db.produtos.update(produtoId, {
      quantidade: produto.quantidade + quantidade
    })
    await db.lancamentos.add({
      tipo: 'entrada',
      produtoId,
      nomeProduto: produto.nome,
      quantidade,
      data: new Date().toISOString(),
      observacao,
    })
  })
}
