// Tipos de lançamento e seus rótulos/cores, compartilhados entre as telas.

// Movimentam estoque (e podem ser revertidos ao excluir).
export const TIPOS_MOVIMENTACAO = ['entrada', 'saida_ficha', 'saida_manual', 'ajuste', 'producao']

// Eventos de cadastro/auditoria (não mexem no estoque).
export const TIPOS_CADASTRO = ['produto_novo', 'produto_excluido', 'produto_editado', 'ficha_nova', 'ficha_excluida', 'ficha_editada']

export const ehCadastro = (t) => TIPOS_CADASTRO.includes(t)

export const TIPO_LABEL = {
  entrada: '+ Entrada',
  saida_ficha: '- Ficha',
  saida_manual: '- Manual',
  ajuste: '± Ajuste',
  producao: '⚙ Produção',
  produto_novo: '🆕 Produto',
  produto_excluido: '🗑 Produto',
  produto_editado: '✏ Produto',
  ficha_nova: '🆕 Ficha',
  ficha_excluida: '🗑 Ficha',
  ficha_editada: '✏ Ficha',
}

export const TIPO_COR = {
  entrada: 'green',
  saida_ficha: 'orange',
  saida_manual: 'red',
  ajuste: 'blue',
  producao: 'yellow',
  produto_novo: 'gray',
  produto_excluido: 'gray',
  produto_editado: 'gray',
  ficha_nova: 'gray',
  ficha_excluida: 'gray',
  ficha_editada: 'gray',
}
