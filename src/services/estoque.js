import { supabase } from '../lib/supabase'
import { session } from '../lib/session'

// As mutações de estoque são feitas por RPCs transacionais no Postgres
// (lancar_*). Cada uma roda em UMA transação, com decremento atômico
// (greatest(0, quantidade - x)) no banco — sem read-modify-write no cliente,
// o que elimina race condition (lost update) e estado parcial em falha.
// A organização e o user_id são derivados no servidor (auth.uid()), então o
// cliente não envia mais organizacao_id. Ver as funções em supabase-setup.sql.

export async function registrarEntrada(produtoId, quantidade, observacao = '', marca = '') {
  const { error } = await supabase.rpc('lancar_entrada', {
    p_produto_id: produtoId,
    p_quantidade: quantidade,
    p_observacao: observacao,
    p_marca: marca || null,
  })
  if (error) throw new Error(error.message)
}

export async function registrarSaidaManual(produtoId, quantidade, observacao = '') {
  const { error } = await supabase.rpc('lancar_saida_manual', {
    p_produto_id: produtoId,
    p_quantidade: quantidade,
    p_observacao: observacao,
  })
  if (error) throw new Error(error.message)
}

export async function registrarSaidaFicha(fichaId, quantidade, observacao = '') {
  const { error } = await supabase.rpc('lancar_saida_ficha', {
    p_ficha_id: fichaId,
    p_quantidade: quantidade,
    p_observacao: observacao,
  })
  if (error) throw new Error(error.message)
}

// Ajuste de inventário: fixa o estoque no valor contado e registra a diferença.
export async function registrarAjuste(produtoId, quantidadeContada, notaExtra = '') {
  const { error } = await supabase.rpc('lancar_ajuste', {
    p_produto_id: produtoId,
    p_quantidade_contada: quantidadeContada,
    p_nota_extra: notaExtra,
  })
  if (error) throw new Error(error.message)
}

// Produção (ficha de produção): consome insumos (com a decisão da reserva "OU")
// e gera o produto de saída. Retorna a quantidade gerada.
export async function registrarProducao(fichaId, lotes, observacao = '') {
  const { data, error } = await supabase.rpc('lancar_producao', {
    p_ficha_id: fichaId,
    p_lotes: parseFloat(lotes),
    p_observacao: observacao,
  })
  if (error) throw new Error(error.message)
  return data
}

// Registra um evento de cadastro/auditoria no histórico (não mexe no estoque).
// O nome do item vai na observação para sobreviver mesmo se o item for excluído.
export async function registrarEvento(tipo, { produtoId = null, fichaId = null, nome = '' } = {}) {
  const orgId = session.organizacaoId
  if (!orgId) return
  const { error } = await supabase.from('lancamentos').insert({
    organizacao_id: orgId,
    tipo,
    produto_id: produtoId,
    ficha_id: fichaId,
    quantidade: 0,
    observacao: nome,
    user_id: session.userId,
  })
  // Auditoria é best-effort: uma falha aqui não deve derrubar a operação
  // principal (cadastro/edição). Apenas registramos no console.
  if (error) console.warn('[estoque] falha ao registrar evento', tipo, error.message)
}

// Exclui um lançamento do histórico, revertendo seu efeito no estoque numa
// única transação (RPC excluir_lancamento). A reversão é EXATA: usa o snapshot
// (coluna itens) do que foi realmente consumido — independe da ficha atual e
// respeita a fonte efetiva da reserva "OU". Lançamentos antigos (sem snapshot)
// caem no fallback dentro da RPC. Cadastros (produto_novo, ...) só são removidos.
export async function excluirLancamento(id) {
  const { error } = await supabase.rpc('excluir_lancamento', { p_id: id })
  if (error) throw new Error(error.message)
}
