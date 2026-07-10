# Documentação Técnica — Frontend (Autocell)

Interface web do SaaS de gestão para Alojamento Local, construída com **Next.js 14 (App Router)**, **TypeScript**, **Tailwind CSS** e componentes **shadcn/ui** (estilo *New York*).

> Nesta fase, o frontend usa **dados fictícios (mock data)** — sem ligação à API. O objetivo é validar design, layout e comportamento responsivo.

---

## 1. Stack tecnológica

| Camada          | Tecnologia        | Função                                                         |
|-----------------|-------------------|----------------------------------------------------------------|
| Framework       | Next.js 14.2.x    | App Router, SSR/SSG, rotas por ficheiro                        |
| Linguagem       | TypeScript 5      | Tipagem estática                                               |
| Estilos         | Tailwind CSS 3.4  | Utilitários CSS + design tokens via CSS variables             |
| Componentes UI  | shadcn/ui         | Componentes base (Button, Card, Badge, Avatar, Separator)     |
| Ícones          | lucide-react      | Conjunto de ícones SVG                                         |
| Utilitários     | clsx, tailwind-merge, class-variance-authority | Combinação de classes + variantes |

> **Nota sobre dependências:** os componentes shadcn foram criados **sem Radix UI** (exceto onde estritamente necessário), de forma a manter o número de dependências mínimo. O `Button` usa `asChild={false}` nativo.

---

## 2. Estrutura de ficheiros

```
frontend/
├── package.json              # Dependências e scripts
├── next.config.mjs           # Configuração do Next.js
├── tsconfig.json             # Configuração TypeScript (paths @/*)
├── tailwind.config.ts        # Tema Tailwind + cores shadcn
├── postcss.config.mjs        # PostCSS (Tailwind + Autoprefixer)
├── components.json           # Configuração shadcn/ui (estilo new-york)
├── .env.example              # Modelo de variáveis de ambiente
├── .gitignore
└── src/
    ├── middleware.ts          # Proteção de rotas (Edge): /admin/** e /staff/** exigem token; / e /login redirecionam autenticados
    ├── app/
    │   ├── globals.css       # Variáveis CSS do tema premium (azul marinho) — light/dark
    │   ├── layout.tsx        # Layout root (fonte Inter, lang pt-PT)
    │   ├── page.tsx          # Landing page premium (1 botão 'Entrar na Plataforma' → /login)
    │   ├── login/
    │   │   └── page.tsx      # Ecrã de Login (POST /api/auth/login, redirect por role / ?from=)
    │   ├── admin/
    │   │   ├── layout.tsx    # Layout admin + RouteGuard (role admin)
    │   │   ├── page.tsx      # Dashboard (estatísticas, tarefas, equipa)
    │   │   ├── propriedades/page.tsx   # Consome API real (GET/POST)
    │   │   ├── equipa/page.tsx         # Placeholder
    │   │   └── calendario/page.tsx     # Placeholder
    │   ├── manager/
    │   │   ├── layout.tsx    # Layout manager + RouteGuard (role manager)
    │   │   ├── page.tsx      # Dashboard do responsável (tarefas + equipa)
    │   │   ├── tarefas/page.tsx        # Placeholder
    │   │   └── equipa/page.tsx          # Placeholder
    │   └── staff/
    │       ├── layout.tsx    # Layout staff + RouteGuard (role staff)
    │       ├── page.tsx      # Área do Staff (mobile-first)
    │       └── tarefas/[id]/page.tsx  # Detalhe da Tarefa (checklist + concluir)
    ├── components/
    │   ├── ui/               # shadcn: button, card, badge, avatar, separator, checkbox, textarea, input
    │   ├── admin/
    │   │   ├── admin-sidebar.tsx    # Sidebar responsiva (desktop fixa / mobile overlay)
    │   │   └── placeholder-page.tsx # Componente de página "Em breve"
    │   ├── auth/
    │   │   └── route-guard.tsx      # Camada client-side de proteção (valida token + role)
    │   ├── manager/
    │   │   └── manager-sidebar.tsx  # Sidebar do responsável de limpezas
    │   └── staff/
    │       ├── task-card.tsx             # Cartão de tarefa (link para detalhe)
    │       └── detalhe-tarefa-client.tsx # Ecrã de detalhe (estado interativo)
    └── lib/
        ├── utils.ts          # cn() — clsx + tailwind-merge
        ├── api.ts             # Helpers de fetch (adminGet/adminPost) com Authorization Bearer
        ├── auth.ts            # Gestão do token JWT em **cookie** (middleware lê) + ler user do payload
        └── mock-data.ts      # Dados fictícios (ainda usados em /staff e dashboard)
```

---

## 3. Sistema de rotas

A aplicação tem **três áreas privadas** (cada uma com layout próprio), uma página de login e uma landing page pública — todas com proteção de rotas (ver secção 12):

| Rota            | Descrição                                          | Abordagem         |
|-----------------|----------------------------------------------------|-------------------|
| `/`             | Landing premium — 1 botão 'Entrar na Plataforma' → `/login` | — |
| `/login`        | **Login** (POST /api/auth/login; redirect por role / `?from=`) | Centrado, premium |
| `/admin`        | Painel de Administração (Dashboard com dados reais) — **protegido** (role admin) | Desktop-first |
| `/admin/propriedades` | **Consome API real** (GET/POST/PATCH propriedades + geocoding) | Desktop-first |
| `/admin/tarefas`      | Gestão manual de tarefas (criar + atribuir + cancelar) + exportação CSV + paginação | Desktop-first |
| `/admin/equipa`       | CRUD completo de equipa + folgas + telefone + falta súbita + baixa + paginação | Desktop-first |
| `/admin/aprovacoes`   | Pedidos de Férias (Centro de Aprovações RH): tabela pendentes + Aprovar/Rejeitar | Desktop-first |
| `/admin/calendario`   | Calendário geral de operações (grelha mensal estilo Google) | Desktop-first |
| `/admin/calendario-operacional` | Calendário operacional avançado (filtros + navegação meses + cartões coloridos por estado + modal com reatribuição rápida) | Desktop-first |
| `/admin/relatorios`   | Relatórios/Analytics com gráficos (recharts: linha, barras, pie) | Desktop-first |
| `/admin/webhooks`     | Logs de webhooks do Smoobu (status, payload, erro, reproccessar) | Desktop-first |
| `/staff`        | Área do Staff — tarefas de limpeza do dia — **protegida** (role staff) | Mobile-first |
| `/staff/ausencias` | Pedidos de ausência do staff (férias/doença/outro) — criar + histórico + cancelar pendentes | Mobile-first |
| `/staff/tarefas/[id]` | Detalhe da Tarefa (checklist + concluir)      | Mobile-first |

### 3.1 Área Admin (`/admin`)

- **Barra lateral** (`admin-sidebar.tsx`) com 9 itens: **Dashboard**, **Propriedades**, **Tarefas**, **Equipa**, **Pedidos de Férias**, **Calendário Operacional**, **Calendário de Folgas**, **Relatórios**, **Webhooks**.
  - Desktop (`lg+`): sidebar fixa à esquerda, sempre visível.
  - Mobile: colapsada; abre como **overlay** ao tocar no botão de menu (hambúrguer).
  - Item ativo destacado com cor primária (dourado). Toggle de tema (claro/escuro) no fundo.
- **Dashboard** (`/admin`): cartões de estatística em tempo real (Propriedades, Staff ativo, Tarefas hoje, Por atribuir, Concluídas) + estado da equipa com carga de trabalho (`GET /api/admin/dashboard`).
- **Propriedades** (`/admin/propriedades`): CRUD completo (criar + **editar** + toggle ativo/inativo) + morada com geocoding automático (re-geocoding ao editar). Modal de edição com Nome, Morada e Tempo de Limpeza (Smoobu ID **read-only**). Formulário de criação tem **dropdown de apartamentos do Smoobu** (carregado via `GET /api/admin/smoobu/propriedades`) — ao escolher, o `smoobu_id` e o `nome` são preenchidos automaticamente (fallback manual se a API key não estiver configurada). Botão **"Sincronizar Smoobu"** no cabeçalho que importa todos os apartamentos do Smoobu de uma vez (`POST /api/admin/smoobu/sincronizar-propriedades`) — upsert que não altera as propriedades já existentes (preserva edições manuais), mostra feedback de sucesso com contadores e atualiza a tabela.
- **Tarefas** (`/admin/tarefas`): gestão manual (criar + atribuir + cancelar) + botão de exportação CSV + paginação client-side. Botão **"Sincronizar Smoobu"** (ícone Download) que faz pull das reservas futuras via REST API (`POST /api/admin/smoobu/sincronizar`) — idempotente, mostra feedback de sucesso/erro e atualiza a grelha.
- **Equipa** (`/admin/equipa`): CRUD completo + folgas fixas semanais + telefone + botão Falta Súbita + botão Baixa/Férias + paginação client-side.
- **Pedidos de Férias** (`/admin/aprovacoes`): Centro de Aprovações de RH — tabela de pedidos pendentes com Nome do Funcionário, Tipo, Datas, Notas + botões **Aprovar** (verde, redistribui tarefas automaticamente) e **Rejeitar** (vermelho). Toast de sucesso com contadores de redistribuição. Responsive (tabela desktop + cards mobile). Consome `GET /api/admin/ausencias?estado=pendente` + `PATCH /api/admin/ausencias/:id/estado`.
- **Calendário de Folgas** (`/admin/calendario`): grelha mensal estilo Google Calendar com tarefas + ausências + modal de detalhe.
- **Calendário Operacional** (`/admin/calendario-operacional`): vista mensal avançada com filtros (propriedade, staff, estado — incl. "Por atribuir"), navegação entre meses (Anterior/Hoje/Seguinte + badge com mês/ano em pt-PT), cartões de tarefa coloridos por estado (vermelho=por atribuir, âmbar=atribuída, verde=concluída, cinza=cancelada) com hover elevation, e modal de detalhe com reatribuição rápida via dropdown. Consome `GET /api/admin/calendario/dados` (auto-refresh quando filtros ou mês mudam). Legenda visual no fundo.
- **Relatórios** (`/admin/relatorios`): analytics com gráficos recharts — evolução diária (linha), produtividade por funcionário (barras), distribuição por estado (pie) + tabela de carga por propriedade. Filtro de período (7/30/90 dias ou datas custom).
- **Webhooks** (`/admin/webhooks`): histórico de webhooks recebidos do Smoobu — cartões de filtro por estado (todos/recebidos/processados/com erro) com contagem + lista expandível com action, reserva, propriedade, check-in, data + payload bruto (JSON formatado) + mensagem de erro (se houver) + botão "Reprocessar" para webhooks com erro. Essencial para confirmar que o Smoobu está a enviar e fazer debug quando algo falha.

### 3.2 Área Staff (`/staff`)

- **Mobile-first**: container com largura máxima `max-w-md` centrado.
- **Cabeçalho fixo** com:
  - Avatar (iniciais do nome)
  - Mensagem "Bem-vindo, [Nome]"
  - Data de hoje (formato pt-PT) e resumo (nº de tarefas + tempo total)
- **Lista de cartões** (`task-card.tsx`), cada um representando uma **Tarefa de Limpeza do dia** com:
  - Nome da propriedade
  - Tipo (ícone + label: Limpeza / Check-in / Check-out / Manutenção)
  - **Hora limite**
  - **Estimativa de tempo** (minutos → formato `XhYY`)
  - Endereço (opcional)
  - Estado (Atribuída / Por atribuir) com badge colorido
  - Botão "Iniciar tarefa" → abre o **Detalhe da Tarefa** (`/staff/tarefas/[id]`). Em tarefas "Por atribuir" o botão fica desativado.
- **Rodapé** fixo com identidade "Autocell · Área do Staff".

#### Página `/staff/ausencias` — Pedidos de Ausência

- **Botão "Novo Pedido de Ausência"** no topo → abre modal com formulário:
  - Tipo (select: Férias / Doença / Outro)
  - Data de Início + Data de Fim (input date, com `min` dinâmico)
  - Notas (opcional)
  - Submissão → `POST /api/staff/ausencias` (estado fica sempre `pendente`). Mensagem de sucesso: "Pedido enviado para aprovação."
- **Histórico de pedidos** (cards): cada cartão mostra o tipo, as datas formatadas (pt-PT), notas (se houver), data do pedido, e uma **Badge de estado**:
  - Pendente → amarelo (`secondary`)
  - Aprovada → verde (`default`)
  - Rejeitada → vermelho (`destructive`)
- **Cancelar pedidos pendentes**: botão de lixeira (ícone `Trash2`) só aparece em pedidos pendentes. `DELETE /api/staff/ausencias/:id` (backend valida que só pendentes podem ser cancelados → 403 se já aprovada/rejeitada).
- Consome `GET /api/staff/ausencias` (via proxy `/api/staff/[...path]` com cookie httpOnly).

### 3.3 Ecrã de Detalhe da Tarefa (`/staff/tarefas/[id]`)

Ecrã mobile-first apresentado quando o Staff clica num cartão de tarefa atribuída.

- **Cabeçalho fixo** com:
  - Link "Voltar" para `/staff`
  - Ícone do tipo de tarefa + **nome da propriedade no topo** + label do tipo
  - Metadados rápidos: hora limite, estimativa e endereço
- **Checklist interativa** (gerada a partir de um array `string[]`):
  - Cada item tem uma **checkbox** controlada por React State (`itensMarcados[]`).
  - Badge com contador `{concluídos}/{total}` e barra de progresso visual.
  - Itens marcados ficam riscados e com fundo esverdeado.
- **Campo de texto (textarea)** opcional "Observações ou Problemas" com contador de caracteres (máx. 500).
- **Botão grande "Concluir Tarefa"** fixo no fundo do ecrã.

#### Regra de Negócio Visual (implementada com React State)
> O botão **"Concluir Tarefa" está `disabled`** até que **todas as checkboxes** da checklist estejam marcadas (`todasMarcadas = itensConcluidos === total && total > 0`).
>
> Enquanto não estão todas marcadas, o botão mostra o progresso `Concluir Tarefa (X/Y)` e uma legenda explicativa por baixo. Quando todas estão marcadas, o botão fica ativo (cor primária + ícone de confirmação) e, ao clicar, mostra "Tarefa concluída!" e volta para a lista de tarefas.

#### Arquitetura
- `app/staff/tarefas/[id]/page.tsx` — **Server Component**: valida o `id` contra o mock data (`getTarefaPorId`), resolve a checklist (a da tarefa ou a por defeito) e passa ao Client Component. Se o id não existir → `notFound()`.
- `components/staff/detalhe-tarefa-client.tsx` — **Client Component** (`"use client"`): gere o estado (`itensMarcados`, `observacoes`, `concluida`) e aplica a regra de negócio visual.

---

## 4. Tema visual

### Rebranding Premium Dourado (v1.7.0)
Inspirado em sites corporativos de Property Management de luxo (ex.: All2Gether). Estética dourada/sobre-areia, "afiada" e sofisticada.

- **Cor primária:** Dourado/Areia elegante (`hsl(43 74% 49%)`) — luxo, sofisticado. (Anterior: azul marinho `blue-950` — abandonado.)
- **Paleta exata (light):**
  - `--background`: `0 0% 100%` (branco puro)
  - `--foreground`: `222 47% 11%` (azul/cinza muito escuro — texto)
  - `--primary`: `43 74% 49%` (dourado/areia)
  - `--primary-foreground`: `0 0% 100%` (branco sobre dourado)
  - `--card` / `--popover`: `0 0% 100%` (branco puro)
  - `--muted` / `--secondary` / `--accent`: `210 40% 96%` (cinza super suave)
  - `--border` / `--input`: `214.3 31.8% 91.4%` (hairline)
  - `--ring`: `43 74% 49%` (igual ao primary)
- **Dark mode luxuoso:** fundo `222 47% 11%` (azul/cinza escuro), primary ligeiramente mais brilhante (`43 74% 55%`) com texto escuro sobre dourado — contraste de luxo.
- **Border-radius global:** `0.25rem` — bordas "afiadas" e corporativas (ainda mais sharp que a versão anterior `0.3rem`).
- **Sombras:** **flat** e sofisticado. `Card` usa `border-border/60` + `shadow-sm`; `Button` default usa apenas `shadow-sm` (sem `hover:shadow-md` — elevação removida para visual mais flat).
- **Estilo shadcn:** *New York*, com CSS variables (suporte light/dark).
- **Tipografia:** Inter (via `next/font/google`); pesos `font-light` (corpo) e `font-semibold` (títulos) para hierarquia premium.
- **Landing page (`/`):** fundo limpo (sem gradiente), padrão de pontos subtil em radial-gradient, marca minimalista (quadrado dourado com "A"), botão grande e elegante (`h-12 px-10 tracking-wide`).
- **Responsividade:** mobile-first em toda a aplicação; breakpoints Tailwind (`sm`, `lg`, `xl`).
- **Acessibilidade:** alvos táteis ≥ 44px, `aria-label` nos botões de menu, semântica HTML (`header`, `main`, `footer`, `nav`).

---

## 5. Dados fictícios (Mock Data)

Definidos em `src/lib/mock-data.ts`. A estrutura **espelha os modelos do backend** para facilitar a integração futura:

| Tipo TS              | Modelo backend correspondente     |
|----------------------|-----------------------------------|
| `PropriedadeMock`    | `backend/models/Propriedade.js`   |
| `MembroEquipaMock`   | `backend/models/Utilizador.js`    |
| `TarefaMock`         | `backend/models/Tarefa.js`        |

Inclui: `staffAtual` (utilizador staff simulado), `tarefasHoje` (4 tarefas, cada uma com `checklist: string[]`), `equipa` (4 membros), `propriedades` (4 alojamentos), `resumoDashboard` (estatísticas agregadas), `checklistPorDefeito` (fallback) e o helper `getTarefaPorId(id)` (usado no ecrã de detalhe).

> Quando a ligação à API for ativada, basta substituir as importações de `mock-data.ts` por chamadas `fetch` aos endpoints do backend (mesmos campos).

---

## 6. Variáveis de ambiente

Definidas em `.env.example` (copiar para `.env.local`). Nesta fase (mock) não são obrigatórias.

| Variável             | Descrição                                              |
|----------------------|--------------------------------------------------------|
| `NEXT_PUBLIC_API_URL`| URL base da API backend (Render). Usada na fase de integração. |

---

## 7. Scripts disponíveis

| Script         | Comando        | Descrição                                  |
|----------------|----------------|--------------------------------------------|
| `npm run dev`  | `next dev`     | Servidor de desenvolvimento (porta 3000)   |
| `npm run build`| `next build`   | Build de produção                          |
| `npm start`    | `next start`   | Servidor de produção                       |
| `npm run lint` | `next lint`    | ESLint                                     |

---

## 8. Instalação e execução local

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

Abrir http://localhost:3000 → landing page com links para `/admin` e `/staff`.

---

## 9. Deploy na Vercel

### ⚠️ Definições obrigatórias no Vercel

Para evitar o erro `No Output Directory named "public" found`, é **obrigatório** configurar:

| Definição (Project Settings) | Valor                          | Notas                                                            |
|------------------------------|--------------------------------|------------------------------------------------------------------|
| **Root Directory**           | `frontend`                     | O `package.json` do Next.js está em `frontend/`, não na raiz do repo. |
| **Framework Preset**         | **Next.js**                    | Se não for detetado automaticamente, selecionar manualmente.     |
| Build Command                | `next build` *(auto)*          | Deixar o auto quando Framework = Next.js.                        |
| Output Directory             | `.next` *(auto)*               | **Não** definir como `public` — `public` é só para assets estáticos. |
| Install Command              | `npm install` *(auto)*         |                                                                  |
| Environment Variables        | `NEXT_PUBLIC_API_URL`          | URL do backend no Render (ex.: `https://autocell-backend.onrender.com`). |

> **Causa do erro `public`:** quando o Vercel não reconhece o projeto como Next.js, assume o preset "Other" (site estático) e procura a pasta `public/` como output. A correção é garantir que o **Framework Preset = Next.js** e que o **Root Directory = `frontend`**.

### `frontend/vercel.json` (rede de segurança)

Para garantir que o Vercel trata o projeto como Next.js — mesmo que a auto-deteção falhe —, o repositório inclui `frontend/vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs"
}
```

Isto força o framework para `nextjs`, pelo que o output directory passa a `.next` e o build command a `next build` automaticamente. **Este ficheiro só é lido se o Root Directory estiver definido como `frontend`.**

### Passos para (re)configurar um projeto já criado no Vercel
1. Vercel → Project → **Settings** → **General**.
2. **Root Directory** → `frontend` → Save.
3. **Settings → Build & Development Settings** → confirmar que o **Framework Preset = Next.js** (se estiver "Other", o build falha com o erro `public`). Se necessário, override e selecionar Next.js.
4. **Settings → Environment Variables** → adicionar `NEXT_PUBLIC_API_URL`.
5. **Deployments** → Redeploy.

---

## 10. Regras e convenções

- **Branch de desenvolvimento:** `dev`.
- **Documentação:** sempre que o frontend é alterado, este ficheiro e o `README.md` são atualizados.
- **Linguagem:** interface e comentários em **pt-pt**.
- **Integração com a API:** `/admin/propriedades` consome a API real com **JWT** (v1.3.0); `/login` faz autenticação; as restantes secções (`/staff`, dashboard) ainda usam `mock-data.ts`.

---

## 11. Autenticação e Integração com a API backend

### `src/lib/auth.ts` — Gestão do token JWT (cookie seguro)
- `guardarToken(token)` / `lerToken()` / `removerToken()` — token guardado **EXCLUSIVAMENTE num cookie** (`autocell_token`, `SameSite=Strict; Secure; path=/; expires=7d`). v1.13.0: localStorage **removido** (era vulnerável a XSS).
- **Flags de segurança do cookie (v1.13.0):**
  - `SameSite=Strict` — o cookie NÃO é enviado em pedidos cross-site (mitiga CSRF).
  - `Secure` — o cookie só é enviado over HTTPS (em `http://localhost` o cookie não será definido — testar em HTTPS ou ajustar temporariamente em dev).
- `lerUtilizadorDoToken()` — descodifica o payload JWT (base64url) **sem verificar assinatura** (isso é responsabilidade do backend); devolve `{ id, role, empresa_id }` ou `null` se inválido/expirado.
- `estaAutenticado()` — true se houver token válido.
- `rotaPorRole(role)` — devolve `/admin` para admin, `/gestor` para gestor, `/staff` para staff (usado no redirect pós-login).

### `src/lib/api.ts` — Helpers de fetch
- `API_URL` — lê `process.env.NEXT_PUBLIC_API_URL`.
- `adminHeaders()` — inclui `Authorization: Bearer <token>` **se houver token** no cookie. v1.12.0: **sem fallback** — se não houver token, não envia header `x-empresa-id` (o backend devolve 401). A proteção de rotas (middleware.ts + RouteGuard) garante que o utilizador só chega a páginas privadas com token válido.
- `adminGet(path)` / `adminPost(path, body)` / `adminPut(path, body)` / `adminPatch(path, body?)` / `adminDelete(path)` — wrappers de `fetch` para GET/POST/PUT/PATCH/DELETE com tratamento de erros. Em `401`, removem o token (força novo login).
- `LoginResponse` — tipo da resposta de `POST /api/auth/login`.
- `UtilizadorDTO` / `Role` — tipos que espelham o modelo `Utilizador` do backend.
- `AusenciaDTO` / `TipoAusencia` — tipos que espelham o modelo `Ausencia` do backend.

### `/login` (Client Component)
Ecrã minimalista premium centrado:
- Formulário com **Email** + **Password** + botão **Entrar** (design premium: azul marinho, padrão de pontos de fundo, marca "A").
- Ao submeter: `POST /api/auth/login` (sem auth header — endpoint público).
- Em caso de sucesso: `guardarToken(token)` + `router.push(rotaPorRole(role))` → **admin → `/admin`**, **staff → `/staff`**.
- Estados: loading (spinner), erro (cartão vermelho com a mensagem do backend).

### `/admin/propriedades` (Client Component)
Primeiro ecrã a consumir a API real (mock-data abandonado nesta secção):

- `useEffect` chama `adminGet('/api/admin/propriedades')` ao montar.
- Apresenta as propriedades numa **tabela HTML** (Tailwind) com colunas **Nome**, **Smoobu ID**, **Tempo de Limpeza**, **Estado**.
- Estados visuais: loading (spinner), erro (cartão vermelho com “Tentar novamente”), vazio (call-to-action).
- Botão **“Nova Propriedade”** no topo → abre formulário **inline** (Card) com campos **Nome**, **Smoobu ID**, **Tempo de Limpeza**.
- Ao submeter: `adminPost('/api/admin/propriedades', { ... })`, limpa o formulário e volta a chamar `carregar()` para atualizar a tabela automaticamente.
- Validações no cliente: Nome e Smoobu ID obrigatórios; Tempo de Limpeza numérico `>= 0`.

### `/admin/equipa` (Client Component) — CRUD completo (v1.9.0 + v1.10.0)
- `useEffect` chama `adminGet('/api/admin/equipa')` ao montar.
- **Tabela** com colunas: **Nome**, **Email**, **Role** (Badge), **Responsável** (nome do superior hierárquico ou "—"), **Estado** (Badge Ativo/Inativo), **Ações**.
- **Adicionar**: botão "Adicionar Funcionário" → formulário inline (Nome, Email, Password, Role select **sem Admin**, **Responsável select** populado com admin+manager) → `adminPost`.
- **Editar**: botão ✏️ por linha → abre **modal Dialog** com Nome, Email, Role (**sem Admin**), **Responsável select** + **Nova Password (opcional)** → `adminPut`. Password vazia = mantém atual. O utilizador a editar é excluído do select de Responsável (não pode ser responsável de si próprio).
- **Ativar/Desativar**: botão ⏻ por linha → `adminPatch('/equipa/:id/estado')` com otimismo (atualiza UI imediatamente, reverte se falhar).
- **Eliminar**: botão 🗑️ por linha → abre **modal de confirmação** (Dialog) → `adminDelete`. Aviso: "ação permanente".
- **Admin = só de leitura**: linhas com `role === "admin"` **não mostram botões de ação** (Editar/Ativar/Eliminar escondidos). Mostra "—" no lugar das ações. Isto reflete as regras 403 do backend (não é possível modificar/eliminar admins via `/api/admin/equipa`).
- Após cada operação (criar/editar/eliminar), a tabela atualiza-se automaticamente (`carregar()`).
- Componente `Dialog` (shadcn, sem Radix) em `components/ui/dialog.tsx` — backdrop, fecho com Esc/clique fora, scroll bloqueado.

### `/admin/calendario` (Client Component) — Folgas e Férias (v1.11.0)
- `useEffect` carrega em paralelo: `adminGet('/api/admin/ausencias?futuras=true')` + `adminGet('/api/admin/equipa')` (para popular o select de funcionários, filtrado a staff+manager).
- **Formulário "Marcar Ausência"** no topo: select Funcionário, Data de Início, Data de Fim, select Tipo (Folga/Férias), Notas (opcional), botão "Agendar" → `adminPost`.
- **Tabela** de ausências agendadas: Funcionário, Tipo (Badge com ícone Plane/Sun), Período (datas formatadas pt-PT), Notas, Ações.
- **Eliminar**: botão 🗑️ por linha → `adminDelete` com otimismo (remove da UI imediatamente, reverte se falhar).
- Validações no cliente: funcionário + datas obrigatórios; `data_fim >= data_inicio`.
- Tipo `AusenciaDTO` + `TipoAusencia` em `lib/api.ts`.
- **Integração com webhook**: as ausências registadas aqui excluem automaticamente o staff da atribuição automática de tarefas (o `webhookController` consulta `Ausencia` no passo 4).

---

## 12. Proteção de Rotas (v1.5.0)

A proteção de rotas usa **duas camadas complementares**:

### 12.1 `src/middleware.ts` (camada servidor / Edge)
Executado antes de renderizar qualquer página. Lê o cookie `autocell_token` (definido por `lib/auth.ts` após login):

- **Rotas privadas** (`/admin/*`, `/gestor/*`, `/staff/*`):
  - Sem token (ou token inválido/expirado) → redireciona para `/login?from=<rota>` (preserva a rota pretendida).
  - Token válido mas role errado (ex.: staff tenta aceder a `/admin`) → redireciona para o painel do role.
  - Token válido + role certo → deixa passar.
- **Rotas públicas para autenticados** (`/`, `/login`):
  - Com token válido → redireciona para o painel do role (`/admin`, `/gestor` ou `/staff`).
  - Sem token → deixa passar (mostra landing/login).
- `matcher`: `/`, `/login`, `/admin/:path*`, `/gestor/:path*`, `/staff/:path*` (ignora `_next`, `api`, estáticos).
- **Não verifica a assinatura** do JWT (seria arriscado no Edge); valida apenas formato + `exp`. A verificação real é feita pelo backend em cada pedido à API.

### 12.2 `components/auth/route-guard.tsx` (camada client-side)
Client Component aplicado nos layouts de `/admin`, `/gestor` e `/staff` (envolve o conteúdo). Segunda camada de defesa:

- Re-valida o token no client (`lerUtilizadorDoToken` — descodifica e verifica `exp`).
- Confirma que o `role` do utilizador corresponde ao role da área.
- Mostra um **spinner** enquanto valida (evita flash de conteúdo protegido).
- Se falhar → `router.replace('/login')`.

### 12.3 `lib/auth.ts` — token em cookie (necessário para middleware)
O token passou a ser guardado num **cookie** (`autocell_token`, SameSite=Lax, 7 dias) em vez de localStorage, porque o `middleware.ts` (Edge) só consegue ler cookies, não localStorage. Mantém-se localStorage como backup. Funções: `guardarToken`, `lerToken`, `removerToken`, `lerUtilizadorDoToken`, `estaAutenticado`, `rotaPorRole`.

### 12.4 Fluxo de redirecionamento pós-login
- Login com sucesso → `guardarToken(token)` (define cookie) → redirect para `?from=` (se vier de rota protegida) ou `rotaPorRole(role)`.
- `rotaPorRole`: admin → `/admin`, gestor → `/gestor`, staff → `/staff`.
- Se um utilizador autenticado aceder a `/login` ou `/` → middleware redireciona para o painel.

### 12.5 Área `/manager` (Responsável de Limpezas) — v1.6.0 (removida)
Área privada original (role `manager`) com sidebar própria. **Removida em v1.37.0** — o painel operacional passou a ser `/gestor/*` (role `gestor`) e o painel `/manager/*` foi eliminado por redundância. O conteúdo (Dashboard, Tarefas, Equipa, Pedidos de Férias, Calendário Operacional) está agora integralmente em `/gestor/*`.

---

## 13. Histórico de alterações (frontend)

| Data    | Versão | Alteração                                                                       |
|---------|--------|---------------------------------------------------------------------------------|
| Inicial | 1.0.0  | Scaffold Next.js 14 + TS + Tailwind + shadcn; rotas `/admin` (sidebar + dashboard + placeholders) e `/staff` (mobile-first com cartões de tarefas); mock data. Build validado. |
| v1.1.0  | 1.1.0  | Ecrã de Detalhe da Tarefa (`/staff/tarefas/[id]`): checklist interativa gerada de array, textarea de observações, botão "Concluir Tarefa" desativado até todas as checkboxes marcadas (React State). Componentes UI Checkbox e Textarea. TaskCard agora abre o detalhe via Link. |
| v1.1.1  | 1.1.1  | Fix deploy Vercel: adicionado `vercel.json` (`"framework": "nextjs"`) para forçar a deteção do framework e evitar o erro `No Output Directory named "public"`. Documentação de deploy atualizada com definições obrigatórias (Root Directory = `frontend`, Framework Preset = Next.js). |
| v1.2.0  | 1.2.0  | Integração com a API real na secção Propriedades: `lib/api.ts` (helpers `adminGet`/`adminPost` + `EMPRESA_ID` placeholder via header `x-empresa-id`); `/admin/propriedades` convertido em Client Component com `useEffect` (GET), tabela HTML (Nome, Smoobu ID, Tempo, Estado) e formulário inline de criação (POST + refresh automático). Componente UI `Input`. Mock-data abandonado nesta secção. |
| v1.2.1  | 1.2.1  | `EMPRESA_ID` preenchido com o ID real do “Cliente Zero” (`6a400c9009e37b27fe0bc362`) devolvido por `GET /api/admin/setup`. Placeholder `COLA_AQUI_O_ID` removido. |
| v1.3.0  | 1.3.0  | **Rebranding Premium:** primary mudada de emerald-600 → Azul Marinho Premium (`blue-950`); `--radius` reduzido de `0.5rem` → `0.3rem` (visual "sharp"); `Card` e `Button` com `shadow-sm` + borders hairline (`border-border/60`); landing page reescrita (gradiente verde removido, fundo limpo com padrão de pontos, tipografia `font-light`/`font-semibold`, cartões com elevação no hover `hover:-translate-y-0.5`). |
| v1.4.0  | 1.4.0  | **Autenticação JWT:** `lib/auth.ts` (guardar/ler/remover token + descodificar payload + `rotaPorRole`); `lib/api.ts` atualizado para enviar `Authorization: Bearer <token>` (com fallback legacy `x-empresa-id` e limpeza de token em `401`); nova rota `/login` (ecrã minimalista premium, `POST /api/auth/login`, redirect admin→`/admin` / staff→`/staff`). |
| v1.5.0  | 1.5.0  | **Proteção de rotas + landing simplificada:** `middleware.ts` (Edge) protege `/admin/**` e `/staff/**` (sem token → `/login?from=`), redireciona autenticados de `/` e `/login`, e valida role por área; `lib/auth.ts` passou a guardar token em **cookie** (middleware lê) em vez de localStorage; `components/auth/route-guard.tsx` (2ª camada client-side) aplicado nos layouts admin/staff; landing page simplificada (removidos cartões Admin/Staff, 1 botão 'Entrar na Plataforma' → `/login`); `/login` lê `?from=` e redireciona autenticados via `useEffect`. |
| v1.6.0  | 1.6.0  | **Novo role `manager` (Responsável de Limpezas):** tipo `Role = admin \| manager \| staff` em `lib/auth.ts`, `lib/api.ts`, `middleware.ts`, `route-guard.tsx`; `rotaPorRole` atualizada (manager → `/manager`); nova área `/manager` (layout + `manager-sidebar.tsx` + dashboard com tarefas + equipa + placeholders `/manager/tarefas` e `/manager/equipa`); `middleware.ts` protege `/manager/**`; `mock-data` atualizado com role manager + membro manager na equipa; dashboard admin inclui managers na equipa operacional. |
| v1.7.0  | 1.7.0  | **Rebranding Premium Dourado:** primary mudada de azul marinho (`blue-950`) → Dourado/Areia (`hsl(43 74% 49%)`); `--radius` reduzido de `0.3rem` → `0.25rem` (ainda mais "afiado"); `--muted`/`--secondary`/`--accent` = `210 40% 96%` (cinza super suave); `--border`/`--input` = `214.3 31.8% 91.4%`; dark mode luxuoso (fundo escuro + dourado brilhante `43 74% 55%`); `Button` default: removido `hover:shadow-md` (visual flat); landing page: botão maior e elegante (`h-12 px-10 tracking-wide`). Inspirado em All2Gether. |
| v1.8.0  | 1.8.0  | **Gestão de Equipa (`/admin/equipa`):** convertido em Client Component — `useEffect` chama `GET /api/admin/equipa` (JWT); tabela HTML (Nome, Email, Role com Badge, Estado); botão "Adicionar Funcionário" abre formulário inline (Nome, Email, Password, Role select); `POST /api/admin/equipa` cria utilizador (bcrypt no backend), limpa formulário e atualiza tabela. Tipo `UtilizadorDTO` + `Role` em `lib/api.ts`. |
| v1.9.0  | 1.9.0  | **CRUD completo de Utilizadores (`/admin/equipa`):** coluna "Ações" com 3 botões por linha — Editar (✏️ abre modal Dialog com Nome/Email/Role/Nova Password opcional → `PUT`), Ativar/Desativar (⏻ → `PATCH /:id/estado` com otimismo), Eliminar (🗑️ abre modal de confirmação → `DELETE`). Helpers `adminPut`/`adminPatch`/`adminDelete` em `lib/api.ts`. Componente `Dialog` (shadcn, sem Radix) em `components/ui/dialog.tsx`. |
| v1.10.0 | 1.10.0 | **Segurança hierárquica + Responsável:** `UtilizadorDTO` com `responsavel_id` + `responsavel` (populado); dropdown de Role nos formulários de criar/editar **sem opção Admin** (só Staff/Responsável); novo select **Responsável** populado com utilizadores admin+manager (exclui o próprio utilizador na edição); nova coluna **Responsável** na tabela; linhas de admin são **só de leitura** (botões Editar/Ativar/Eliminar escondidos, mostram "—"). Reflete regras 403 do backend. |
| v1.11.0 | 1.11.0 | **Calendário de Folgas e Férias (`/admin/calendario`):** convertido em Client Component — formulário "Marcar Ausência" (Funcionário select, Data Início/Fim, Tipo Folga/Férias, Notas) → `POST /api/admin/ausencias`; tabela de ausências (Funcionário, Tipo com Badge+ícone, Período formatado pt-PT, Notas, Eliminar); botão 🗑️ com otimismo. Tipo `AusenciaDTO` + `TipoAusencia` em `lib/api.ts`. Ausências integram com o webhook (excluem staff da atribuição automática). |
| v1.12.0 | 1.12.0 | **Remoção do fallback legacy `x-empresa-id`:** `lib/api.ts` — removida constante `EMPRESA_ID` e fallback `x-empresa-id` do `adminHeaders`. Agora envia **apenas** `Authorization: Bearer <token>` se houver token; sem token, não envia header (backend devolve 401). Comentário em `propriedades/page.tsx` atualizado. Alinha com o backend v1.10.0 (middleware auth estrito). |
| v1.13.0 | 1.13.0 | **Cookie seguro (anti-XSS):** `lib/auth.ts` — cookie com `SameSite=Strict` (anti-CSRF) + `Secure` (apenas HTTPS); `localStorage` **completamente removido** (era vulnerável a XSS — script injetado conseguiria ler o token). Token vive agora **exclusivamente** no cookie. `guardarToken`/`removerToken` operam apenas o cookie. `deleteCookie` atualizado com mesmas flags para garantir sobreposição. |
| Prompt 95 | — | **Ecrã de Férias/Ausências + Staff Preferencial + Detalhes da Reserva (Fase 1.5):** (1) `/gestor/ausencias` deixou de ser redirect e passou a **tabela definitiva** com TODAS as ausências da empresa (sem filtros de estado): colunas Funcionário, Tipo (ícone), Período, Estado (Badge), Notas, Ações (Eliminar com modal de confirmação → `DELETE /api/gestor/ausencias/:id` com otimismo). O menu lateral já apontava para `/gestor/ausencias` (mantido). (2) `/gestor/propriedades` modal de Editar: novo **select de Funcionário Preferencial** (carrega staff ativo via `GET /api/gestor/equipa`, filtra `role==='staff'`); grava via `PUT /api/gestor/propriedades/:id` com `funcionario_preferencial_id` (string vazia → null). `PropriedadeDTO` + `TarefaMock` atualizados em `lib/api.ts` com `funcionario_preferencial_id` e `detalhes_reserva`. (3) Novo componente partilhado `components/detalhes-reserva-card.tsx` — Card de destaque com Check-in, Check-out, Hóspedes (pax) e Nome do Hóspede; só renderiza se `detalhes_reserva` existir. Usado em: `components/staff/detalhe-tarefa-client.tsx` (topo do detalhe da tarefa no mobile do staff) e novo `components/gestor/detalhe-tarefa-modal.tsx` (modal aberto via botão Eye na tabela de tarefas do gestor, mostra propriedade/tipo/estado/data/staff/observações/avarias + o card de detalhes_reserva). Build + lint + tsc ✓. |
| Ajuste | — | **Ocultar staff indisponíveis do dropdown de atribuição:** o modal "Atribuir Tarefa" (`/gestor/tarefas`) e o modal de reatribuição do Calendário (`/gestor/calendario`) deixaram de mostrar os staff indisponíveis (férias/doença/ausência nesse dia) como `<option disabled>` e passam a **omitir** da lista via `.filter(u => !indisponiveis.some(i => i.utilizador_id === u._id))`. A lista só contém quem pode realmente receber a tarefa. O aviso amarelo abaixo do select foi atualizado de "não podem receber tarefas" para "foram omitidos da lista". Antes (v1.59.0/Prompt 81) os indisponíveis apareciam a cinzento/desativados; agora não aparecem. Build + lint + tsc ✓. |
| Prompt 99 | — | **Ecrã de Relatório no Calendário — Vista Tabela + Exportar Excel:** `/gestor/calendario` ganhou um **Toggle de vistas** no cabeçalho (Vista Calendário / Vista Tabela) e um botão **Exportar Excel**. (1) **Toggle:** `vista: "calendario" \| "tabela"` — quando "tabela" está ativo, o FullCalendar é escondido e mostra-se uma Data Table com as tarefas do período/filtros selecionados (excluindo ausências/folgas que só fazem sentido no calendário), ordenadas por data crescente. Colunas: Data (DD/MM/YYYY), Propriedade, Reserva (`In: [checkin] Out: [checkout] - [pax] pax` via `detalhes_reserva`), Funcionário (nome ou "Por Atribuir" a amarelo), Horário (`HH:mm - HH:mm`), Estado (Badge colorido: por_atribuir=destructive, atribuida=default, em_curso=warning, concluida=success, cancelada=outline). Clicar numa linha abre o modal de detalhe existente. (2) **Exportar Excel:** botão que instala a lib `xlsx` (^0.18.5); ao clicar, constrói um Workbook com `XLSX.utils.json_to_sheet` (colunas Data/Propriedade/Reserva/Funcionário/Horário/Estado, larguras definidas via `!cols`) e faz `XLSX.writeFile(wb, "Relatorio_Limpezas.xlsx")`. `xlsx` importado dinamicamente (`await import("xlsx")`) para não entrar no bundle inicial. Todos os campos vão como texto (datas DD/MM/YYYY) — o Excel interpreta como texto. Interface `TarefaCalendario` alargada com `detalhes_reserva`. Build + lint + tsc ✓. |
| Prompt 100 | — | **Garantir os Dados do Excel (robustez):** (1) Novo helper `formatarReservaExcel` (variante do `formatarReserva`) que devolve **string vazia** quando a tarefa não tem `detalhes_reserva` (ex: manutenção) — a célula do Excel fica em branco em vez de "—". Os sub-campos em falta (checkin/checkout/pax) também ficam vazios; se nenhum estiver preenchido, devolve vazio (não "In:  Out:  - "). A `exportarExcel` passou a usar `formatarReservaExcel` e a deixar em branco Propriedade/Horário em falta. (2) `ESTADO_LABEL_TAB` atualizado: `em_curso` passa a "Em Curso" (C maiúsculo, capitalização de título) para corresponder ao pedido do prompt; restantes estados já estavam traduzidos (Por Atribuir, Atribuída, Concluída, Cancelada). Backend: confirmado via 2 novos testes que o `GET /api/gestor/calendario/dados` já devolve `detalhes_reserva` (usa `.lean()` sem `.select()`). Build + lint + tsc ✓; backend 125/125 ✓. |
| Prompt 101 | — | **Controlo de Utilizadores no Painel de Admin (Fullstack):** `/admin` ganhou um botão **"Gerir Utilizadores"** (ícone Users) por cada empresa na tabela. Ao clicar, abre um **modal** que lista todos os utilizadores (gestores + staff) dessa empresa via `GET /api/admin/empresas/:empresaId/utilizadores` (proxy route). Tabela com colunas Nome, Email, Role (Badge Gestor/Staff), Estado (Badge Ativo/Inativo) e um botão **Ativar/Desativar** (ícone Power) que faz `PATCH .../utilizadores/:id/estado` com otimismo. Botão **"Criar Novo Gestor"** no fundo do modal abre um mini-formulário (Nome, Email, Password) que faz `POST .../utilizadores` com `role: 'gestor'` — para empresas que ficaram com 0 gestores. Novos proxy routes: `api/admin/empresas/[empresaId]/utilizadores/route.ts` (GET+POST) e `api/admin/empresas/[empresaId]/utilizadores/[utilizadorId]/estado/route.ts` (PATCH). Tipo `UtilizadorEmpresaDTO`. Build + lint + tsc ✓. |
| Prompt 113 | — | **Mega Prompt de Correção (Alpha):** (1) **Loop 401 + Layouts** — `lib/auth.ts` `lerUtilizador()` deixou de fazer `window.location.href=/login` como side-effect em 401 (era pura, devolve `null`); adicionado cache **in-flight** (callers paralelos partilham a mesma Promise → 1 fetch em vez de N). `components/auth/route-guard.tsx` — redirect único com flag `redirecionado`; trata role errado (→ painel certo). `gestor/layout.tsx` continua com `AdminSidebar mode="gestor"` (nunca mostra menu de admin). (2) **Banner de impersonação** — novo client component `components/gestor/impersonation-banner.tsx` (lê `sessionStorage` em `useEffect`, evita problemas de hidratação); botão **VERMELHO "Voltar a Admin"** que chama `POST /api/auth/exit-impersonation` (restaura cookie de admin guardado), limpa `sessionStorage` e vai para `/admin`. `api/admin/impersonar/[id]/route.ts` guarda o token de admin num cookie separado `autocell_admin_token` antes de o substituir; novo `api/auth/exit-impersonation/route.ts` troca de volta; `login` e `logout` limpam o cookie de backup. (3) **Cockpit Admin limpo** — `/admin/sistema` reescrito: removidas as tabs e todas as opções de Smoobu/Sincronizações/Webhooks/Configuração (nome empresa + API key); fica só Forçar Cron Jobs globais + Push de teste + Hard Reset, com um aviso a apontar para `/gestor/configuracoes`. (4) **Calendário + timezone** — botão **"Nova Tarefa"** no cabeçalho de `/gestor/calendario` abre um modal de criação (Propriedade, Data, Tempo, Tipo, Staff opcional). Helpers novos em `lib/utils.ts`: `paraIsoMeiaNoiteLocal("YYYY-MM-DD")` (envia meia-noite LOCAL como ISO) e `temHoraReal(iso)` (hora local ≥ 8). Tarefas sem hora real (criadas só com data) são renderizadas como **all-day** no FullCalendar (visíveis na faixa all-day das vistas semanal/diária em vez de invisíveis abaixo do slotMinTime 08:00); na Vista Tabela, o horário mostra "—". `tarefas/page.tsx` e o novo modal do calendário enviam `paraIsoMeiaNoiteLocal(form.data)`. (5) **Bloqueio de tarefa concluída** — `components/staff/detalhe-tarefa-client.tsx`: se `tarefa.estado === "concluida"`, desativa checkboxes (`disabled`), textarea, e esconde botões Concluir/Atraso/Avaria (mostra banner "Concluída"); pré-marca todos os itens. Modal do calendário: botão "Reatribuir" e dropdown de staff `disabled` quando concluída. (6) `/gestor/propriedades` ganhou botão **"Checklist Padrão"** (ícone ListChecks) que aplica o checklist padrão a todas as propriedades via `POST /api/gestor/propriedades/default-checklist` (com `confirm`). Build + lint + tsc ✓; backend 136/136 ✓. |
| Prompt 114 | — | **Notificações In-App, Bugs Alpha e Lógica de Distâncias (frontend):** (1) **Push Notifications** — `components/staff/push-notification-setup.tsx` (re-exportado em `components/gestor/`) já faz `pushManager.subscribe` + `POST /api/auth/me/push-subscribe` (via catch-all proxy). Confirmado funcional. (2) **Centro de Notificações (O Sino)** — novo `components/notification-bell.tsx`: ícone Bell com badge vermelho (count de não-lidas), dropdown com lista, polling a 30s, marca todas como lidas ao abrir (`PATCH /marcar-lidas`). Renderizado no header do `GestorSidebar` (desktop + mobile) e no header do `/staff` (ao lado do logout). Usa `/api/auth/me/notificacoes/*` (via catch-all proxy). (3) **Isolamento Menu Admin** — `/gestor/layout.tsx` deixou de importar `AdminSidebar` (partilhado). Novo `components/gestor/gestor-sidebar.tsx` dedicado (não importa nada de admin); o layout usa-o. Itens: Dashboard, Propriedades, Tarefas, Equipa, Ausências, Calendário, Relatórios, Webhooks, Configurações + Sino + Tema + Logout. (4) **Staff ativo** — `/gestor/tarefas/page.tsx` e `/gestor/calendario/page.tsx` filtram `u.role === "staff" && u.ativo === true` (antes só role). (5) **Capacidade destacada** — `TarefaMock` (lib/api.ts) + `TarefaDetalheGestor` ganham `capacidade_hospedes`. `components/gestor/detalhe-tarefa-modal.tsx` e `components/staff/detalhe-tarefa-client.tsx` mostram badge âmbar "Lotação máxima: N hóspede(s)" (ícone Users). `/staff/tarefas/[id]/page.tsx` passa `capacidade_hospedes` do populate. (6) **Toasts de warning** — `/gestor/propriedades/page.tsx` (geocoding falhou ao criar/editar), `/gestor/tarefas/page.tsx` (distância >15km ao criar/atribuir) e `/gestor/calendario/page.tsx` (distância ao criar/reatribuir) capturam `res.warning` e mostram Card âmbar (`border-amber-500/50 bg-amber-50`). Lint + tsc + build ✓; backend 143/143 ✓. |
