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

// Ajusta o estoque de um produto por um delta (+ entra, − sai), nunca negativo.
// Helper best-effort usado pela reversão: não lança para não abortar o loop de
// reverterLancamento no meio (preserva o comportamento atual); só observa erros.
// (A reversão atômica/exata é o item #2 — snapshot.)
async function ajustarEstoque(produtoId, delta) {
  if (!produtoId) return
  const { data: prod, error: errSel } = await supabase.from('produtos').select('quantidade').eq('id', produtoId).single()
  if (errSel) { console.warn('[estoque] falha ao ler produto p/ reverter', produtoId, errSel.message); return }
  if (!prod) return
  const { error: errUpd } = await supabase
    .from('produtos')
    .update({ quantidade: Math.max(0, (prod.quantidade || 0) + delta) })
    .eq('id', produtoId)
  if (errUpd) console.warn('[estoque] falha ao reverter produto', produtoId, errUpd.message)
}

// Reverte o efeito de um lançamento no estoque (usado ao excluí-lo do histórico).
// Assume que nada mudou desde a ação; receitas usam a versão atual da ficha.
// Best-effort: as leituras internas apenas observam erros (não lançam) para a
// reversão seguir o mesmo comportamento de sempre. A reversão exata (snapshot)
// é um item separado.
export async function reverterLancamento(l) {
  if (!l) return
  const qtd = parseFloat(l.quantidade) || 0

  if (l.tipo === 'entrada') {
    await ajustarEstoque(l.produto_id, -qtd)
  } else if (l.tipo === 'saida_manual') {
    await ajustarEstoque(l.produto_id, +qtd)
  } else if (l.tipo === 'saida_ficha') {
    if (l.ficha_id) {
      const { data: ings, error } = await supabase
        .from('ficha_ingredientes').select('produto_id, quantidade').eq('ficha_id', l.ficha_id)
      if (error) console.warn('[estoque] falha ao ler insumos p/ reverter saída', error.message)
      for (const ing of ings || []) await ajustarEstoque(ing.produto_id, +ing.quantidade * qtd)
    }
  } else if (l.tipo === 'producao') {
    // remove o produto gerado
    await ajustarEstoque(l.produto_id, -qtd)
    // devolve os insumos consumidos (recalcula os lotes pela receita atual)
    if (l.ficha_id) {
      const { data: ficha, error: errFicha } = await supabase
        .from('fichas_tecnicas').select('rendimento').eq('id', l.ficha_id).single()
      if (errFicha) console.warn('[estoque] falha ao ler ficha p/ reverter produção', errFicha.message)
      const rendimento = ficha?.rendimento
      if (rendimento && rendimento > 0) {
        const lotes = qtd / rendimento
        const { data: ings, error: errIng } = await supabase
          .from('ficha_ingredientes').select('produto_id, quantidade').eq('ficha_id', l.ficha_id)
        if (errIng) console.warn('[estoque] falha ao ler insumos p/ reverter produção', errIng.message)
        for (const ing of ings || []) await ajustarEstoque(ing.produto_id, +ing.quantidade * lotes)
      }
    }
  } else if (l.tipo === 'ajuste') {
    // desfaz a diferença aplicada, lida da observação "... (±Δ)"
    const m = (l.observacao || '').match(/\(([+-]?\d+(?:[.,]\d+)?)\)/)
    if (m) {
      const delta = parseFloat(m[1].replace(',', '.'))
      if (!isNaN(delta)) await ajustarEstoque(l.produto_id, -delta)
    }
  }
}
