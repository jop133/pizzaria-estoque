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
  estoque_minimo numeric default 0
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
  user_id uuid references auth.users(id)
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

-- Organizações: ver e criar
create policy "ver minha org" on organizacoes
  for select using (id in (select organizacao_id from membros where user_id = auth.uid()));
create policy "criar org" on organizacoes
  for insert with check (auth.uid() is not null);

-- Membros: ver, inserir, atualizar, deletar
create policy "ver membros da org" on membros
  for select using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid()));
create policy "inserir membro" on membros
  for insert with check (auth.uid() is not null);
create policy "atualizar membro" on membros
  for update using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid() and papel = 'dono'));
create policy "remover membro" on membros
  for delete using (organizacao_id in (select organizacao_id from membros where user_id = auth.uid() and papel = 'dono'));

-- Convites: ver (qualquer autenticado para validar), criar (dono), usar (atualizar)
create policy "ver convites" on convites
  for select using (auth.uid() is not null);
create policy "criar convite" on convites
  for insert with check (organizacao_id in (select organizacao_id from membros where user_id = auth.uid() and papel = 'dono'));
create policy "usar convite" on convites
  for update using (auth.uid() is not null);

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
