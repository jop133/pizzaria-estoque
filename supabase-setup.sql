-- =============================================
-- SETUP DO BANCO DE DADOS - Pizzaria Estoque
-- Cole este SQL no SQL Editor do Supabase
-- =============================================

-- Organizações (grupos/empresas)
create table if not exists organizacoes (
  id uuid default gen_random_uuid() primary key,
  nome text not null,
  dono_id uuid references auth.users(id),
  criado_em timestamptz default now()
);

-- Membros (vínculo usuário ↔ organização com papel)
create table if not exists membros (
  id uuid default gen_random_uuid() primary key,
  organizacao_id uuid references organizacoes(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  papel text not null check (papel in ('dono', 'admin', 'funcionario')),
  nome text,
  email text,
  criado_em timestamptz default now(),
  unique(organizacao_id, user_id)
);

-- Convites (tokens de acesso único)
create table if not exists convites (
  id uuid default gen_random_uuid() primary key,
  organizacao_id uuid references organizacoes(id) on delete cascade not null,
  token text unique not null,
  criado_por uuid references auth.users(id),
  usado boolean default false,
  criado_em timestamptz default now(),
  expira_em timestamptz not null
);

-- Produtos
create table if not exists produtos (
  id bigint generated always as identity primary key,
  organizacao_id uuid references organizacoes(id) on delete cascade not null,
  nome text not null,
  categoria text default 'Outros',
  unidade text default 'un',
  quantidade numeric default 0,
  estoque_minimo numeric default 0,
  preco numeric default 0  -- preço de custo (R$); migração: alter table produtos add column if not exists preco numeric default 0;
);

-- Fichas Técnicas
create table if not exists fichas_tecnicas (
  id bigint generated always as identity primary key,
  organizacao_id uuid references organizacoes(id) on delete cascade not null,
  nome text not null,
  categoria text default 'Pizza',
  descricao text default '',
  -- 'prato' (consome ingredientes na venda) ou 'producao' (fabrica um produto)
  tipo_ficha text default 'prato',
  -- produto gerado ao produzir (somente fichas de producao)
  produto_saida_id bigint references produtos(id) on delete set null,
  -- quanto cada producao rende, na unidade do produto gerado
  rendimento numeric
);

-- Migracao para bancos ja existentes (rode uma vez no SQL Editor do Supabase):
-- alter table fichas_tecnicas
--   add column if not exists tipo_ficha text default 'prato',
--   add column if not exists produto_saida_id bigint references produtos(id) on delete set null,
--   add column if not exists rendimento numeric;

-- Ingredientes das Fichas
create table if not exists ficha_ingredientes (
  id bigint generated always as identity primary key,
  ficha_id bigint references fichas_tecnicas(id) on delete cascade not null,
  produto_id bigint references produtos(id) on delete cascade not null,
  quantidade numeric not null
);

-- Lançamentos (histórico de movimentações)
create table if not exists lancamentos (
  id bigint generated always as identity primary key,
  organizacao_id uuid references organizacoes(id) on delete cascade not null,
  tipo text not null,
  data timestamptz default now(),
  ficha_id bigint references fichas_tecnicas(id) on delete set null,
  produto_id bigint references produtos(id) on delete set null,
  quantidade numeric not null,
  observacao text default '',
  user_id uuid references auth.users(id),
  -- snapshot do que foi REALMENTE aplicado por produto: [{"p":id,"d":delta}, ...]
  -- (d = mudança real no estoque; + entrou, − saiu). Usado p/ reversão exata.
  -- migração: alter table lancamentos add column if not exists itens jsonb;
  itens jsonb
);

-- =============================================
-- SEGURANÇA (Row Level Security)
-- =============================================

alter table organizacoes enable row level security;
alter table membros enable row level security;
alter table convites enable row level security;
alter table produtos enable row level security;
alter table fichas_tecnicas enable row level security;
alter table ficha_ingredientes enable row level security;
alter table lancamentos enable row level security;

-- Organizações: só SELECT. NÃO há policy de INSERT — a criação é feita pela RPC
-- criar_organizacao (SECURITY DEFINER). A antiga "criar org" (auth.uid() is not
-- null) foi removida em jun/2026 (defesa em profundidade).
-- migração: drop policy if exists "criar org" on organizacoes;
create policy "ver minha org" on organizacoes
  for select using (id in (select organizacao_id from membros where user_id = auth.uid()));

-- Membros: ver, atualizar, deletar. NÃO há policy de INSERT — as inserções
-- legítimas são feitas dentro das RPCs DEFINER (criar_organizacao /
-- entrar_por_convite), que ignoram o RLS. A antiga "inserir membro"
-- (auth.uid() is not null) deixava QUALQUER logado se inserir como dono de
-- qualquer org (furo CRÍTICO de isolamento entre tenants) — removida jun/2026.
-- migração: drop policy if exists "inserir membro" on membros;
create policy "ver membros da org" on membros
  for select using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));
create policy "atualizar membro" on membros
  for update using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid() and papel = 'dono'));
create policy "remover membro" on membros
  for delete using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid() and papel = 'dono'));

-- Convites: a RPC entrar_por_convite é SECURITY DEFINER (ignora RLS), então ela
-- lê o token e marca usado=true por dentro. O cliente NUNCA faz select/update
-- direto em convites — só o INSERT do dono. Por isso:
--   - SELECT é escopado à própria org (evita enumeração de tokens entre orgs);
--   - não há policy de UPDATE (a RPC definer cuida do usado=true);
--   - INSERT continua restrito ao dono.
create policy "ver convites" on convites
  for select using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));
create policy "criar convite" on convites
  for insert with check (organizacao_id in (select organizacao_id from membros where user_id = auth.uid() and papel = 'dono'));

-- Migração (aplicada): apertar o RLS de convites em bancos já existentes —
-- drop policy if exists "ver convites" on convites;
-- create policy "ver convites" on convites
--   for select using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));
-- drop policy if exists "usar convite" on convites;

-- Produtos
create policy "ver produtos" on produtos
  for select using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));
create policy "modificar produtos" on produtos
  for all using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));

-- Fichas Técnicas
create policy "ver fichas" on fichas_tecnicas
  for select using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));
create policy "modificar fichas" on fichas_tecnicas
  for all using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));

-- Ingredientes
create policy "ver ingredientes" on ficha_ingredientes
  for select using (ficha_id in (select id from fichas_tecnicas where organizacao_id in (select organizacao_id from membros where user_id = auth.uid())));
create policy "modificar ingredientes" on ficha_ingredientes
  for all using (ficha_id in (select id from fichas_tecnicas where organizacao_id in (select organizacao_id from membros where user_id = auth.uid())));

-- Lançamentos
create policy "ver lancamentos" on lancamentos
  for select using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));
create policy "modificar lancamentos" on lancamentos
  for all using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));

-- =============================================
-- FUNÇÕES / RPCs
-- =============================================
-- Organização e convites (SECURITY DEFINER — precisam ignorar RLS p/ criar
-- vínculos e validar tokens). Já existiam no banco; documentadas aqui.

create or replace function public.criar_organizacao(nome_org text, nome_usuario text)
returns uuid language plpgsql security definer
set search_path = public, pg_temp as $$
declare nova_org_id uuid; uid uuid;
begin
  uid := auth.uid();
  if uid is null then raise exception 'Nao autenticado'; end if;
  insert into organizacoes (nome, dono_id) values (nome_org, uid) returning id into nova_org_id;
  insert into membros (organizacao_id, user_id, papel, nome, email)
    values (nova_org_id, uid, 'dono', nome_usuario, (select email from auth.users where id = uid));
  return nova_org_id;
end; $$;

create or replace function public.entrar_por_convite(convite_token text, nome_usuario text)
returns uuid language plpgsql security definer
set search_path = public, pg_temp as $$
declare conv record; uid uuid;
begin
  uid := auth.uid();
  if uid is null then raise exception 'Nao autenticado'; end if;
  select * into conv from convites where token = convite_token and usado = false and expira_em > now();
  if conv is null then raise exception 'Convite invalido ou expirado'; end if;
  update convites set usado = true where id = conv.id;
  insert into membros (organizacao_id, user_id, papel, nome, email)
    values (conv.organizacao_id, uid, 'funcionario', nome_usuario, (select email from auth.users where id = uid))
    on conflict (organizacao_id, user_id) do nothing;
  return conv.organizacao_id;
end; $$;

create or replace function public.excluir_organizacao(org_id uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from membros where organizacao_id = org_id and user_id = auth.uid() and papel = 'dono'
  ) then
    raise exception 'Apenas o Dono pode excluir a organização';
  end if;
  delete from organizacoes where id = org_id;
end; $$;

-- Mutações de estoque (jun/2026): cada operação roda em UMA transação, com
-- decremento atômico (greatest(0, quantidade - x)) — elimina a race condition
-- do antigo read-modify-write no cliente e o estado parcial em falha. São
-- SECURITY INVOKER de propósito: o RLS continua valendo (defesa em profundidade);
-- a org é derivada da própria entidade e o user vem de auth.uid().

create or replace function public.lancar_entrada(
  p_produto_id bigint, p_quantidade numeric, p_observacao text default '', p_marca text default null
) returns void language plpgsql security invoker as $$
declare v_org uuid;
begin
  select organizacao_id into v_org from produtos where id = p_produto_id;
  if v_org is null then raise exception 'Produto não encontrado'; end if;
  update produtos set quantidade = quantidade + p_quantidade where id = p_produto_id;
  insert into lancamentos (organizacao_id, tipo, produto_id, quantidade, observacao, marca, user_id, itens)
    values (v_org, 'entrada', p_produto_id, p_quantidade, coalesce(p_observacao,''), nullif(p_marca,''), auth.uid(),
            jsonb_build_array(jsonb_build_object('p', p_produto_id, 'd', p_quantidade)));
end; $$;

create or replace function public.lancar_saida_manual(
  p_produto_id bigint, p_quantidade numeric, p_observacao text default ''
) returns void language plpgsql security invoker as $$
declare v_org uuid; v_old numeric; v_new numeric;
begin
  select organizacao_id, quantidade into v_org, v_old from produtos where id = p_produto_id;
  if v_org is null then raise exception 'Produto não encontrado'; end if;
  update produtos set quantidade = greatest(0, quantidade - p_quantidade) where id = p_produto_id
    returning quantidade into v_new;
  insert into lancamentos (organizacao_id, tipo, produto_id, quantidade, observacao, user_id, itens)
    values (v_org, 'saida_manual', p_produto_id, p_quantidade, coalesce(p_observacao,''), auth.uid(),
            jsonb_build_array(jsonb_build_object('p', p_produto_id, 'd', v_new - coalesce(v_old,0))));
end; $$;

create or replace function public.lancar_ajuste(
  p_produto_id bigint, p_quantidade_contada numeric, p_nota_extra text default ''
) returns void language plpgsql security invoker as $$
declare v_org uuid; v_atual numeric; v_contado numeric; v_delta numeric; v_sinal text; v_obs text;
begin
  select organizacao_id, quantidade into v_org, v_atual from produtos where id = p_produto_id;
  if v_org is null then raise exception 'Produto não encontrado'; end if;
  v_atual := coalesce(v_atual, 0);
  v_contado := greatest(0, p_quantidade_contada);
  v_delta := round((v_contado - v_atual), 3);
  if v_delta = 0 then return; end if;
  update produtos set quantidade = v_contado where id = p_produto_id;
  v_sinal := case when v_delta > 0 then '+' else '' end;
  v_obs := 'Contagem: ' || trim_scale(v_atual) || ' → ' || trim_scale(v_contado)
           || ' (' || v_sinal || trim_scale(v_delta) || ')';
  if coalesce(p_nota_extra, '') <> '' then v_obs := v_obs || ' · ' || p_nota_extra; end if;
  insert into lancamentos (organizacao_id, tipo, produto_id, quantidade, observacao, user_id, itens)
    values (v_org, 'ajuste', p_produto_id, v_contado, v_obs, auth.uid(),
            jsonb_build_array(jsonb_build_object('p', p_produto_id, 'd', v_delta)));
end; $$;

create or replace function public.lancar_saida_ficha(
  p_ficha_id bigint, p_quantidade numeric, p_observacao text default ''
) returns void language plpgsql security invoker as $$
declare
  v_org uuid; ing record;
  v_prim_nec numeric; v_fonte_id bigint; v_fonte_qtd numeric; v_estoque numeric; v_prim_estoque numeric;
  v_new numeric; v_itens jsonb := '[]'::jsonb;
begin
  select organizacao_id into v_org from fichas_tecnicas where id = p_ficha_id;
  if v_org is null then raise exception 'Ficha não encontrada'; end if;

  for ing in
    select produto_id, quantidade, produto_alt_id, quantidade_alt
    from ficha_ingredientes where ficha_id = p_ficha_id
  loop
    v_prim_nec := coalesce(ing.quantidade, 0) * p_quantidade;
    select quantidade into v_prim_estoque from produtos where id = ing.produto_id;
    v_fonte_id := ing.produto_id;
    v_fonte_qtd := v_prim_nec;
    v_estoque := v_prim_estoque;
    -- Reserva "OU": se faltar o porcionado, usa o cru.
    if ing.produto_alt_id is not null and coalesce(v_prim_estoque, 0) < v_prim_nec then
      select quantidade into v_estoque from produtos where id = ing.produto_alt_id;
      v_fonte_id := ing.produto_alt_id;
      v_fonte_qtd := coalesce(ing.quantidade_alt, 0) * p_quantidade;
    end if;
    if v_estoque is null then continue; end if;
    update produtos set quantidade = greatest(0, v_estoque - v_fonte_qtd) where id = v_fonte_id
      returning quantidade into v_new;
    -- delta real (respeita o clamp): registra a fonte EFETIVA (porcionado ou cru).
    v_itens := v_itens || jsonb_build_object('p', v_fonte_id, 'd', v_new - v_estoque);
  end loop;

  insert into lancamentos (organizacao_id, tipo, ficha_id, quantidade, observacao, user_id, itens)
    values (v_org, 'saida_ficha', p_ficha_id, p_quantidade, coalesce(p_observacao,''), auth.uid(), v_itens);
end; $$;

create or replace function public.lancar_producao(
  p_ficha_id bigint, p_lotes numeric, p_observacao text default ''
) returns numeric language plpgsql security invoker as $$
declare
  v_org uuid; v_nome text; v_saida_id bigint; v_rend numeric;
  ing record; v_prim_nec numeric; v_fonte_id bigint; v_fonte_qtd numeric; v_disp_prim numeric;
  v_nec jsonb := '{}'::jsonb; v_key text; v_count int := 0; v_falta text := ''; r record; v_gerado numeric;
begin
  if p_lotes is null or p_lotes <= 0 then raise exception 'Informe quantos lotes produzir'; end if;
  select organizacao_id, nome, produto_saida_id, rendimento
    into v_org, v_nome, v_saida_id, v_rend from fichas_tecnicas where id = p_ficha_id;
  if v_org is null then raise exception 'Ficha não encontrada'; end if;
  if v_saida_id is null then raise exception 'Esta ficha de produção não tem um produto gerado definido'; end if;
  if v_rend is null or v_rend <= 0 then raise exception 'Defina o rendimento da ficha de produção'; end if;

  -- 1) Agrega o necessário por produto (a decisão da reserva usa o estoque INICIAL).
  for ing in
    select produto_id, quantidade, produto_alt_id, quantidade_alt
    from ficha_ingredientes where ficha_id = p_ficha_id
  loop
    v_count := v_count + 1;
    v_prim_nec := coalesce(ing.quantidade, 0) * p_lotes;
    v_fonte_id := ing.produto_id;
    v_fonte_qtd := v_prim_nec;
    if ing.produto_alt_id is not null then
      select quantidade into v_disp_prim from produtos where id = ing.produto_id;
      if coalesce(v_disp_prim, 0) < v_prim_nec then
        v_fonte_id := ing.produto_alt_id;
        v_fonte_qtd := coalesce(ing.quantidade_alt, 0) * p_lotes;
      end if;
    end if;
    v_key := v_fonte_id::text;
    v_nec := jsonb_set(v_nec, array[v_key],
      to_jsonb( coalesce((v_nec ->> v_key)::numeric, 0) + v_fonte_qtd ));
  end loop;
  if v_count = 0 then raise exception 'Esta ficha de produção não tem insumos cadastrados'; end if;

  -- 2) Pré-checagem (nada é alterado antes disto).
  for r in select (kv.key)::bigint as produto_id, (kv.value)::numeric as nec from jsonb_each_text(v_nec) kv loop
    declare v_nome_p text; v_un text; v_disp numeric;
    begin
      select nome, unidade, coalesce(quantidade, 0) into v_nome_p, v_un, v_disp from produtos where id = r.produto_id;
      if coalesce(v_disp, 0) < r.nec then
        v_falta := v_falta || case when v_falta <> '' then '; ' else '' end
          || trim(both ' ' from (coalesce(v_nome_p,'Produto') || ' (falta '
             || trim_scale(round(r.nec - coalesce(v_disp,0), 3)) || ' ' || coalesce(v_un,'') || ')'));
      end if;
    end;
  end loop;
  if v_falta <> '' then raise exception 'Estoque insuficiente para produzir: %', v_falta; end if;

  -- 3) Consome (cada produto uma vez; greatest(0, atual - nec) == greatest(0, inicial - nec)).
  update produtos p set quantidade = greatest(0, p.quantidade - (kv.value)::numeric)
    from jsonb_each_text(v_nec) kv where p.id = (kv.key)::bigint;

  -- 4) Gera o produto de saída.
  v_gerado := round(v_rend * p_lotes, 3);
  update produtos set quantidade = quantidade + v_gerado where id = v_saida_id;

  -- 5) Snapshot: consumo (delta − por insumo, sem clamp pois a pré-checagem garante
  --    estoque) + produto gerado (delta +). Registra a fonte EFETIVA da reserva "OU".
  select coalesce(jsonb_agg(jsonb_build_object('p', (kv.key)::bigint, 'd', -(kv.value)::numeric)), '[]'::jsonb)
    into v_itens from jsonb_each_text(v_nec) kv;
  v_itens := v_itens || jsonb_build_object('p', v_saida_id, 'd', v_gerado);

  -- 6) Lançamento.
  insert into lancamentos (organizacao_id, tipo, ficha_id, produto_id, quantidade, observacao, user_id, itens)
    values (v_org, 'producao', p_ficha_id, v_saida_id, v_gerado,
            coalesce(nullif(p_observacao, ''), 'Produção: ' || trim_scale(p_lotes) || ' lote(s) de ' || v_nome),
            auth.uid(), v_itens);
  return v_gerado;
end; $$;

-- Reverte o efeito de um lançamento no estoque E o exclui, numa única transação.
-- Caminho exato via snapshot (itens) quando disponível; senão, fallback com a
-- lógica antiga (recalcula pela ficha atual / lê o (±Δ) da observação) para
-- lançamentos criados antes do snapshot. Cadastros (produto_novo, ...) não têm
-- efeito de estoque: apenas são removidos.
create or replace function public.excluir_lancamento(p_id bigint)
returns void language plpgsql security invoker as $$
declare
  v_lanc lancamentos; el jsonb; v_qtd numeric; v_rend numeric; v_lotes numeric; ing record;
  v_match text; v_delta numeric;
begin
  select * into v_lanc from lancamentos where id = p_id;
  if not found then raise exception 'Lançamento não encontrado'; end if;

  if v_lanc.itens is not null then
    -- Exato: aplica o inverso de cada delta gravado.
    for el in select value from jsonb_array_elements(v_lanc.itens) loop
      update produtos set quantidade = greatest(0, quantidade - (el->>'d')::numeric)
        where id = (el->>'p')::bigint;
    end loop;
  else
    -- Fallback p/ lançamentos antigos (pré-snapshot).
    v_qtd := coalesce(v_lanc.quantidade, 0);
    if v_lanc.tipo = 'entrada' then
      update produtos set quantidade = greatest(0, quantidade - v_qtd) where id = v_lanc.produto_id;
    elsif v_lanc.tipo = 'saida_manual' then
      update produtos set quantidade = quantidade + v_qtd where id = v_lanc.produto_id;
    elsif v_lanc.tipo = 'saida_ficha' then
      if v_lanc.ficha_id is not null then
        for ing in select produto_id, quantidade from ficha_ingredientes where ficha_id = v_lanc.ficha_id loop
          update produtos set quantidade = quantidade + coalesce(ing.quantidade,0) * v_qtd where id = ing.produto_id;
        end loop;
      end if;
    elsif v_lanc.tipo = 'producao' then
      update produtos set quantidade = greatest(0, quantidade - v_qtd) where id = v_lanc.produto_id;
      if v_lanc.ficha_id is not null then
        select rendimento into v_rend from fichas_tecnicas where id = v_lanc.ficha_id;
        if v_rend is not null and v_rend > 0 then
          v_lotes := v_qtd / v_rend;
          for ing in select produto_id, quantidade from ficha_ingredientes where ficha_id = v_lanc.ficha_id loop
            update produtos set quantidade = quantidade + coalesce(ing.quantidade,0) * v_lotes where id = ing.produto_id;
          end loop;
        end if;
      end if;
    elsif v_lanc.tipo = 'ajuste' then
      v_match := substring(coalesce(v_lanc.observacao,'') from '\(([+-]?[0-9]+(?:[.,][0-9]+)?)\)');
      if v_match is not null then
        v_delta := replace(v_match, ',', '.')::numeric;
        update produtos set quantidade = greatest(0, quantidade - v_delta) where id = v_lanc.produto_id;
      end if;
    end if;
  end if;

  delete from lancamentos where id = p_id;
end; $$;
