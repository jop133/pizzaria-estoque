import { supabase } from '../lib/supabase'
import { session } from '../lib/session'

export async function registrarSaidaFicha(fichaId, quantidade, observacao = '') {
  const orgId = session.organizacaoId
  if (!orgId) throw new Error('Sem organização ativa')

  const { data: ingredientes } = await supabase
    .from('ficha_ingredientes')
    .select('produto_id, quantidade')
    .eq('ficha_id', fichaId)

  for (const ing of ingredientes || []) {
    const totalGasto = ing.quantidade * quantidade
    const { data: prod } = await supabase
      .from('produtos')
      .select('quantidade')
      .eq('id', ing.produto_id)
      .single()
    if (!prod) continue
    await supabase
      .from('produtos')
      .update({ quantidade: Math.max(0, prod.quantidade - totalGasto) })
      .eq('id', ing.produto_id)
  }

  await supabase.from('lancamentos').insert({
    organizacao_id: orgId,
    tipo: 'saida_ficha',
    ficha_id: fichaId,
    quantidade,
    observacao,
    user_id: session.userId,
  })
}

export async function registrarSaidaManual(produtoId, quantidade, observacao = '') {
  const orgId = session.organizacaoId
  if (!orgId) throw new Error('Sem organização ativa')

  const { data: prod } = await supabase
    .from('produtos')
    .select('quantidade')
    .eq('id', produtoId)
    .single()
  if (!prod) throw new Error('Produto não encontrado')

  await supabase
    .from('produtos')
    .update({ quantidade: Math.max(0, prod.quantidade - quantidade) })
    .eq('id', produtoId)

  await supabase.from('lancamentos').insert({
    organizacao_id: orgId,
    tipo: 'saida_manual',
    produto_id: produtoId,
    quantidade,
    observacao,
    user_id: session.userId,
  })
}

export async function registrarEntrada(produtoId, quantidade, observacao = '') {
  const orgId = session.organizacaoId
  if (!orgId) throw new Error('Sem organização ativa')

  const { data: prod } = await supabase
    .from('produtos')
    .select('quantidade')
    .eq('id', produtoId)
    .single()
  if (!prod) throw new Error('Produto não encontrado')

  await supabase
    .from('produtos')
    .update({ quantidade: prod.quantidade + quantidade })
    .eq('id', produtoId)

  await supabase.from('lancamentos').insert({
    organizacao_id: orgId,
    tipo: 'entrada',
    produto_id: produtoId,
    quantidade,
    observacao,
    user_id: session.userId,
  })
}
