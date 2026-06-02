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

// Ajuste de inventário: define o estoque do produto para o valor contado e
// registra a diferença no histórico (tipo 'ajuste'). Não soma/subtrai — fixa.
export async function registrarAjuste(produtoId, quantidadeContada, notaExtra = '') {
  const orgId = session.organizacaoId
  if (!orgId) throw new Error('Sem organização ativa')

  const { data: prod } = await supabase
    .from('produtos')
    .select('quantidade')
    .eq('id', produtoId)
    .single()
  if (!prod) throw new Error('Produto não encontrado')

  const atual = prod.quantidade || 0
  const contado = Math.max(0, quantidadeContada)
  const delta = Math.round((contado - atual) * 1000) / 1000
  if (delta === 0) return // nada mudou, não registra

  await supabase
    .from('produtos')
    .update({ quantidade: contado })
    .eq('id', produtoId)

  const sinal = delta > 0 ? '+' : ''
  const obs = `Contagem: ${atual} → ${contado} (${sinal}${delta})` + (notaExtra ? ` · ${notaExtra}` : '')

  await supabase.from('lancamentos').insert({
    organizacao_id: orgId,
    tipo: 'ajuste',
    produto_id: produtoId,
    quantidade: contado,
    observacao: obs,
    user_id: session.userId,
  })
}

export async function registrarEntrada(produtoId, quantidade, observacao = '', marca = '') {
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
    marca: marca || null,
    user_id: session.userId,
  })
}
