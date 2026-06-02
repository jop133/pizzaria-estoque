import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

function useTabela(table, queryFn, extraDeps = []) {
  const [data, setData] = useState([])
  const { organizacaoId } = useAuth()

  useEffect(() => {
    if (!organizacaoId) { setData([]); return }

    const buscar = async () => {
      const { data: rows } = await queryFn(organizacaoId)
      setData(rows || [])
    }

    buscar()

    // Tempo real via WebSocket
    const channel = supabase
      .channel(`${table}-${organizacaoId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, buscar)
      .subscribe()

    return () => supabase.removeChannel(channel)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizacaoId, ...extraDeps])

  return data
}

export function useProdutos() {
  return useTabela('produtos', (orgId) =>
    supabase.from('produtos').select('*').eq('organizacao_id', orgId).order('nome')
  )
}

export function useFichas() {
  return useTabela('fichas_tecnicas', (orgId) =>
    supabase.from('fichas_tecnicas').select('*').eq('organizacao_id', orgId).order('nome')
  )
}

export function useLancamentos() {
  const [data, setData] = useState([])
  const { organizacaoId } = useAuth()

  useEffect(() => {
    if (!organizacaoId) { setData([]); return }

    const buscar = async () => {
      const { data: rows } = await supabase
        .from('lancamentos')
        .select('*, fichas_tecnicas(nome), produtos(nome, unidade)')
        .eq('organizacao_id', organizacaoId)
        .order('data', { ascending: false })
      setData((rows || []).map(l => ({
        ...l,
        nomeFicha: l.fichas_tecnicas?.nome,
        nomeProduto: l.produtos?.nome,
      })))
    }

    buscar()

    const channel = supabase
      .channel(`lancamentos-${organizacaoId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lancamentos' }, buscar)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [organizacaoId])

  return data
}

export function useFichaIngredientes(fichaId) {
  const [data, setData] = useState([])
  const { organizacaoId } = useAuth()

  useEffect(() => {
    if (!organizacaoId || !fichaId) { setData([]); return }

    const buscar = async () => {
      const { data: rows } = await supabase
        .from('ficha_ingredientes')
        .select('*')
        .eq('ficha_id', fichaId)
      setData(rows || [])
    }

    buscar()

    const channel = supabase
      .channel(`ficha-ing-${fichaId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ficha_ingredientes' }, buscar)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [fichaId, organizacaoId])

  return data
}

export function useProdutosAbaixoMinimo() {
  const produtos = useProdutos()
  return produtos.filter(p => p.quantidade <= (p.estoque_minimo || 0))
}
