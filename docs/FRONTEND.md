# Documentação Técnica — Frontend (All2gether)

Interface web do sistema All2gether de gestão de Alojamento Local e Airbnb, construída com **Next.js 14 (App Router)**, **TypeScript**, **Tailwind CSS** e componentes **shadcn/ui** (estilo *New York*).

> O frontend consome a API REST do backend (Node.js + Express + MongoDB) via proxies same-origin com JWT em cookie httpOnly. Dados reais em produção.

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
    ├── middleware.ts          # Proteção de rotas (Edge): /gestor/** e /staff/** exigem token; / e /login redirecionam autenticados
    ├── app/
    │   ├── globals.css       # Variáveis CSS do tema premium (azul marinho) — light/dark
    │   ├── layout.tsx        # Layout root (fonte Inter, lang pt-PT)
    │   ├── page.tsx          # Landing page premium (1 botão 'Entrar na Plataforma' → /login)
    │   ├── login/
    │   │   └── page.tsx      # Ecrã de Login (POST /api/auth/login, redirect por role / ?from=)
    │   ├── gestor/           # Programa operacional (satélite single-tenant — acesso direto do admin)
    │   │   ├── layout.tsx    # Layout gestor + RouteGuard (role gestor/admin) + ImpersonationBanner (legacy)
    │   │   ├── page.tsx      # Dashboard (estatísticas, equipa, radar de risco)
    │   │   ├── calendario/   # Calendário operacional (ausências têm prioridade visual sobre tarefas)
    │   │   ├── tarefas/      # Gestão de tarefas
    │   │   ├── propriedades/ # CRUD de propriedades (Badge parceiro, Select parceiro, Google Maps, hard-delete admin)
    │   │   ├── equipa/       # CRUD de equipa (+ folgas rotativas)
    │   │   ├── parceiros/    # NOVA: CRUD de parceiros B2B (role 'parceiro')
    │   │   ├── ausencias/    # Ausências + Folgas Fixas (view única, filtros Estado/Mês; sem Tabs)
    │   │   ├── relatorios/   # Analytics + resumo IA
    │   │   ├── checklists/   # NOVA: Modelos de Checklist (página própria, não escondida nas configs)
    │   │   └── configuracoes/ # Configurações da empresa + integracoes (status Smoobu real)
    │   └── staff/
    │       ├── layout.tsx    # Layout staff + RouteGuard (role staff)
    │       ├── page.tsx      # Área do Staff (mobile-first)
    │       └── tarefas/[id]/page.tsx  # Detalhe da Tarefa (checklist + concluir + Google Maps)
    ├── components/
    │   ├── ui/               # shadcn: button, card, badge, avatar, separator, checkbox, textarea, input, switch, tabs, dialog
    │   ├── auth/
    │   │   └── route-guard.tsx      # Camada client-side de proteção (valida token + role)
    │   ├── gestor/
    │   │   ├── gestor-sidebar.tsx   # Sidebar (saudação dinâmica Admin/Gestor; Configurações só para admin)
    │   │   ├── impersonation-banner.tsx     # Banner "Sair da empresa" (legacy — só sessões antigas)
    │   │   └── detalhe-tarefa-modal.tsx     # Modal de detalhe de tarefa
    │   └── staff/
    │       ├── task-card.tsx             # Cartão de tarefa (link + botão Google Maps)
    │       └── detalhe-tarefa-client.tsx # Ecrã de detalhe (estado interativo + Google Maps)
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
| `/gestor`       | **Programa operacional** (Dashboard, Calendário, Tarefas, Propriedades, Equipa, Parceiros, Ausências, Relatórios, Configurações*) — **protegido** (role gestor ou admin) | Desktop-first |
| `/gestor/parceiros` | CRUD de parceiros B2B (role 'parceiro') — criar/editar/ativar/desativar | Desktop-first |
| `/gestor/ausencias` | Gestão de ausências + Dias de Folga (Tabs) | Desktop-first |
| `/staff`        | Área do Staff — tarefas de limpeza do dia — **protegida** (role staff) | Mobile-first |
| `/staff/ausencias` | Pedidos de ausência do staff (férias/doença/outro) — criar + histórico + cancelar pendentes | Mobile-first |
| `/staff/tarefas/[id]` | Detalhe da Tarefa (checklist + concluir)      | Mobile-first |

> **\*** `Configurações` (`/gestor/configuracoes`) só aparece na sidebar e só é acessível para `role === 'admin'` (via `useUserRole()` hook). O gestor não vê nem acede a Configurações.

### 3.1 Programa Operacional (`/gestor`) — antiga "Área Admin"

> **Satélite single-tenant — ACESSO DIRETO DO ADMIN:** o painel `/admin` (gestão cross-tenant de empresas) foi **eliminado**. O Super Admin (role `admin`) aterra **diretamente** na vista operacional `/gestor` sem fluxo de impersonação — o seu `empresa_id` aponta para a empresa operacional única "All2gether" (renomeada via rota `/api/cleanup-final` a partir de "All2gether (Sistema)"). As queries `req.user.empresa_id` devolvem dados reais sem necessidade de impersonação. O componente `<AutoImpersonarEmpresa/>` foi **REMOVIDO** do `gestor/layout.tsx` (commit `16ad06a`). As funcionalidades operacionais (Dashboard, Propriedades, Tarefas, Equipa, Parceiros, Ausências, Calendário, Relatórios, Configurações) vivem todas em `/gestor/*`.

- **Barra lateral** (`gestor-sidebar.tsx`) com os itens: **Dashboard**, **Calendário**, **Limpezas** (tarefas), **Propriedades**, **Equipa**, **Parceiros** (NOVO — ícone `Handshake`), **Ausências / Férias**, **Relatórios**, **Notificações**, **Checklists** e **Configurações** (só visível para `role === 'admin'`) + sino de Notificações.
- **Saudação dinâmica:** a Brand e o cabeçalho mobile mostram "Admin" ou "Gestor" dinamicamente (via `useRoleLabel()` hook que chama `lerUtilizador()` no `useEffect`). Antes era hardcoded "Gestor".
- **Configurações restritas a admin:** o item "Configurações" (`/gestor/configuracoes`) só aparece na sidebar se `userRole === 'admin'` (via `useUserRole()` hook que chama `lerUtilizador()`). O `gestorNavItems` é filtrado no `NavLinks` com `.filter()` que esconde `/gestor/configuracoes` quando `userRole !== 'admin'`. O gestor não vê nem acede a Configurações.
- **Dashboard** (`/gestor`): cartões de estatística em tempo real + estado da equipa com carga de trabalho (`GET /api/gestor/dashboard`).
- As restantes secções (`/gestor/propriedades`, `/gestor/tarefas`, `/gestor/equipa`, `/gestor/parceiros`, etc.) contêm o CRUD operacional completo (anteriormente em `/admin/*`, migrado para `/gestor/*`).

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
  - **Botão "Abrir no Google Maps"** (commit `97c6832`): ícone `Navigation` junto ao endereço da propriedade. URL universal `https://www.google.com/maps/search/?api=1&query=...` (usa coordenadas se existirem, senão a morada string).
- **Rodapé** fixo com identidade "All2gether · Área do Staff".

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
  - **Botão "Abrir no Google Maps"** (commit `97c6832`): ícone `Navigation` junto ao endereço. Mesmo URL universal do `task-card.tsx` — abre o Google Maps na localização da propriedade.
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
| Environment Variables        | `NEXT_PUBLIC_API_URL`          | URL do backend no Render (ex.: `https://all2gether-backend.onrender.com`). |

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
- **Integração com a API:** o frontend consome a API REST do backend (Node.js + Express + MongoDB) via proxies same-origin (`/api/gestor/*`, `/api/staff/*`, `/api/auth/*`) com JWT em cookie httpOnly. `/login` faz autenticação (`POST /api/auth/login`); o `mock-data.ts` mantém-se apenas como fallback/dev para tipagem e testes isolados — em produção, todas as secções (`/gestor/*`, `/staff/*`) usam dados reais.

---

## 11. Autenticação e Integração com a API backend

### `src/lib/auth.ts` — Gestão do token JWT (cookie seguro)
- `guardarToken(token)` / `lerToken()` / `removerToken()` — token guardado **EXCLUSIVAMENTE num cookie** (`all2gether_token`, `SameSite=Strict; Secure; path=/; expires=7d`). v1.13.0: localStorage **removido** (era vulnerável a XSS).
- **Flags de segurança do cookie (v1.13.0):**
  - `SameSite=Strict` — o cookie NÃO é enviado em pedidos cross-site (mitiga CSRF).
  - `Secure` — o cookie só é enviado over HTTPS (em `http://localhost` o cookie não será definido — testar em HTTPS ou ajustar temporariamente em dev).
- `lerUtilizadorDoToken()` — descodifica o payload JWT (base64url) **sem verificar assinatura** (isso é responsabilidade do backend); devolve `{ id, role, empresa_id }` ou `null` se inválido/expirado.
- `estaAutenticado()` — true se houver token válido.
- `rotaPorRole(role)` — devolve `/gestor` para admin e gestor, `/staff` para staff (usado no redirect pós-login). **Satélite single-tenant — ACESSO DIRETO:** o painel `/admin` (gestão cross-tenant de empresas) deixou de fazer sentido neste repositório dedicado — o Super Admin entra diretamente no programa operacional `/gestor`. O `empresa_id` do admin aponta agora para a empresa operacional única "All2gether" (renomeada via rota `/api/cleanup-final` a partir de "All2gether (Sistema)") — sem necessidade de auto-impersonação.

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
- Em caso de sucesso: `limparCacheAuth()` + `router.push(rotaPorRole(role))` → **admin → `/gestor`**, **gestor → `/gestor`**, **staff → `/staff`**. **Acesso direto:** o admin aterra diretamente na vista operacional `/gestor` (sem fluxo de impersonação — o seu `empresa_id` já aponta para a empresa "All2gether").
- Estados: loading (spinner), erro (cartão vermelho com a mensagem do backend).

### Fluxo SSO (satélite single-tenant) — Acesso Direto do Admin

> **⚠️ ATUALIZAÇÃO (commit `16ad06a`):** o componente `<AutoImpersonarEmpresa/>` foi **REMOVIDO** do `gestor/layout.tsx`. O fluxo de auto-impersonação descrito abaixo **é o histórico** — foi substituído pelo **acesso direto** do admin.

O repositório passou de Nave-Mãe (multi-tenant) para **Satélite dedicado à All2gether**. O painel `/admin` (gestão cross-tenant de empresas) deixou de fazer sentido — o Super Admin entra **diretamente no programa operacional** (`/gestor`).

#### Fluxo atual (após commit `16ad06a`) — Acesso Direto

1. Autocell → `GET /api/auth/sso?token=<jwt_externo>` (proxy route do Next.js).
2. Proxy valida com o backend, define o cookie httpOnly `all2gether_token` e **redireciona para `/gestor`**.
3. O `middleware.ts` deixa o admin passar em `/gestor/*` (alinhado com o backend, onde `isGestor = requireRole('admin', 'gestor')`).
4. O `<RouteGuard role="gestor">` aceita admin (alinhado com o `isGestor` do backend).
5. O admin aterra **diretamente** na vista operacional `/gestor` — **sem fluxo de impersonação**. O `empresa_id` do admin aponta para a empresa operacional única **"All2gether"** (renomeada via rota `/api/cleanup-final` a partir de "All2gether (Sistema)").
6. As queries `req.user.empresa_id` devolvem **dados reais** sem necessidade de impersonação.
7. O `<ImpersonationBanner/>` mantém-se no layout **por segurança**: sessões antigas com a flag `all2gether_impersonating` ativa no `sessionStorage` (de impersonações manuais anteriores ao commit `16ad06a`) podem sair do modo impersonado. Para **novas sessões**, a flag nunca é definida e o banner **não aparece** — o admin trabalha diretamente como gestor da empresa "All2gether".

#### Fluxo histórico (REMOVIDO em `16ad06a`) — Auto-Impersonação

> Documentado para contexto histórico. **Não está mais ativo no código.**

1. Autocell → `GET /api/auth/sso?token=<jwt_externo>` (proxy route do Next.js).
2. Proxy valida com o backend, define cookies httpOnly (`all2gether_token` + `all2gether_admin_token`) e **redireciona para `/gestor`**.
3. O `middleware.ts` deixa o admin passar em `/gestor/*`.
4. O `<RouteGuard role="gestor">` aceita admin.
5. ~~O `<AutoImpersonarEmpresa/>` (no `gestor/layout.tsx`) detetava `role === 'admin'` e:~~
   - ~~`GET /api/admin/empresas` → encontrava a primeira empresa ativa, não apagada, com NIF ≠ `SISTEMA` (empresa principal do satélite).~~
   - ~~`POST /api/admin/impersonar/:id` → substituía o cookie pelo token de gestor dessa empresa (mantinha `all2gether_admin_token` guardado).~~
   - ~~Marcava `sessionStorage` (`all2gether_auto_impersonado` + `all2gether_impersonating`) para não repetir.~~
   - ~~`limparCacheAuth()` + `window.location.reload()` → o `/gestor` voltava a montar com o token de gestor e via dados reais.~~
6. O `<ImpersonationBanner/>` mostrava "Sair da empresa" — o admin podia terminar a impersonação (logout + `/login`).

**Porquê foi removida a auto-impersonação?** Antes, o Super Admin era cross-tenant: no token, `empresa_id` apontava para a empresa-sistema `All2gether (Sistema)` (NIF `SISTEMA`, criada pelo `seed-admin.js`), que **não tinha dados operacionais** — daí a necessidade de impersonar. A rota de cleanup `/api/cleanup-final` renomeou a empresa-sistema para **"All2gether"** e o `empresa_id` do admin passou a apontar para ela, tornando a auto-impersonação redundante. As queries `req.user.empresa_id` passam a devolver dados reais diretamente, simplificando o fluxo e eliminando uma troca de token que era propensa a bugs de cache/sessionStorage.

### `/gestor/propriedades` (Client Component)
Primeiro ecrã histórico a consumir a API real (mock-data abandonado nesta secção):

- `useEffect` chama `adminGet('/api/gestor/propriedades')` ao montar.
- Apresenta as propriedades numa **tabela HTML** (Tailwind) com colunas **Nome**, **Parceiro** (Badge), **Tempo de Limpeza**, **Estado**.
- Estados visuais: loading (spinner), erro (cartão vermelho com “Tentar novamente”), vazio (call-to-action).
- Botão **“Nova Propriedade”** no topo → abre formulário **inline** (Card) com campos **Nome**, **Tempo de Limpeza**.
- Ao submeter: `adminPost('/api/gestor/propriedades', { ... })`, limpa o formulário e volta a chamar `carregar()` para atualizar a tabela automaticamente.
- Validações no cliente: Nome obrigatório; Tempo de Limpeza numérico `>= 0`.

#### Badge de Parceiro Associado (commit `2984270`)
- A tabela mostra um **Badge** com o nome do parceiro B2B associado à propriedade (campo `parceiro_id` populado pelo backend).
- **Não se extrai mais das observações** — o relacionamento é feito via `parceiro_id` (campo relacional dedicado).
- Se a propriedade não tiver parceiro associado, mostra **"All2gether"** (default operacional).

#### Select de Parceiro nos formulários
- Nos formulários de **criação** e **edição** de propriedades, há um `<select>` que busca a lista de parceiros via `GET /api/gestor/parceiros`.
- Permite associar um parceiro B2B à propriedade (ou deixar em branco = All2gether).
- O ID selecionado é enviado como `parceiro_id` no payload do POST/PUT.

#### Botão “Abrir no Google Maps”
- Junto à morada na tabela, há um botão com ícone **`Navigation`** (lucide-react) que abre o Google Maps.
- URL universal: `https://www.google.com/maps/search/?api=1&query=...`.
- Se a propriedade tiver **coordenadas** (lat/lng), usa-as; senão, usa a **morada em string**.

#### Hard-Delete para Admin (commit `97c6832`)
- Botão **“Eliminar Definitivamente”** (ícone `Trash2`) visível **exclusivamente** para `userRole === 'admin'` (verificado via `lerUtilizador()` no client).
- Abre um **Dialog de confirmação** com aviso de **irreversibilidade** (a propriedade é removida permanentemente da BD, não vai para a reciclagem).
- Endpoint: `DELETE /api/gestor/propriedades/:id?hard=true`.
- O gestor (role `gestor`) **não vê** este botão — só pode fazer soft-delete.

#### Morada Estruturada (commit `c30edde`)
- Os formulários de criação/edição passaram a ter campos opcionais de **morada estruturada**: `rua`, `codigo_postal`, `cidade`.
- Se preenchidos, **substituem** o campo `morada` (string livre) na resposta do backend.
- Se não preenchidos, mantém-se o campo `morada` legacy para retrocompatibilidade.

### `/gestor/parceiros` (Client Component) — NOVA PÁGINA (commit `c30edde` + `2984270`)
Nova página dedicada à gestão de **parceiros B2B** (utilizadores com `role === 'parceiro'`).

- `useEffect` chama `adminGet('/api/gestor/parceiros')` ao montar (lista apenas utilizadores com role 'parceiro').
- **Tabela** com colunas: **Nome**, **Email**, **Telefone**, **NIF**, **Observações**, **Estado** (Badge Ativo/Inativo), **Ações**.
- **Criar Parceiro**: botão "Novo Parceiro" → abre **Dialog** com campos: Nome, Email, Password, Telefone, NIF, Observações → `POST /api/gestor/equipa` (reutiliza o endpoint da equipa com `role: 'parceiro'`).
- **Editar Parceiro**: botão ✏️ por linha → abre **Dialog** com Nome, Email, Telefone, NIF, Observações + **Nova Password (opcional)** → `PUT /api/gestor/equipa/:id`. Password vazia = mantém atual.
- **Ativar/Desativar** (soft-delete): botão ⏻ por linha → `PATCH /api/gestor/equipa/:id/estado` com otimismo (atualiza UI imediatamente, reverte se falhar).
- Após cada operação (criar/editar/toggle), a tabela atualiza-se automaticamente (`carregar()`).
- **Endpoints**: `GET /api/gestor/parceiros` (lista filtrada); `POST`/`PUT`/`PATCH /api/gestor/equipa` (reutilizados — o backend aceita `role: 'parceiro'` desde o commit `6d8bca1`).
- **Item "Parceiros"** adicionado à sidebar com ícone `Handshake` (lucide-react).
- **Isolamento da Equipa:** parceiros **não aparecem** na página `/gestor/equipa` — são geridos exclusivamente aqui, dado que têm fluxos próprios (telefone/NIF/observações específicos de B2B).

### `/gestor/equipa` (Client Component) — CRUD completo (v1.9.0 + v1.10.0)
- `useEffect` chama `adminGet('/api/gestor/equipa')` ao montar.
- **Tabela** com colunas: **Nome**, **Email**, **Role** (Badge), **Responsável** (nome do superior hierárquico ou "—"), **Estado** (Badge Ativo/Inativo), **Ações**.
- **Adicionar**: botão "Adicionar Funcionário" → formulário inline (Nome, Email, Password, Role select **sem Admin**, **Responsável select** populado com admin+manager) → `adminPost`.
- **Editar**: botão ✏️ por linha → abre **modal Dialog** com Nome, Email, Role (**sem Admin**), **Responsável select** + **Nova Password (opcional)** → `adminPut`. Password vazia = mantém atual. O utilizador a editar é excluído do select de Responsável (não pode ser responsável de si próprio).
- **Ativar/Desativar**: botão ⏻ por linha → `adminPatch('/equipa/:id/estado')` com otimismo (atualiza UI imediatamente, reverte se falhar).
- **Eliminar**: botão 🗑️ por linha → abre **modal de confirmação** (Dialog) → `adminDelete`. Aviso: "ação permanente".
- **Admin = só de leitura**: linhas com `role === "admin"` **não mostram botões de ação** (Editar/Ativar/Eliminar escondidos). Mostra "—" no lugar das ações. Isto reflete as regras 403 do backend (não é possível modificar/eliminar admins via `/api/gestor/equipa`).
- Após cada operação (criar/editar/eliminar), a tabela atualiza-se automaticamente (`carregar()`).
- Componente `Dialog` (shadcn, sem Radix) em `components/ui/dialog.tsx` — backdrop, fecho com Esc/clique fora, scroll bloqueado.
- **Folgas rotativas** (HF10): secção no modal de edição com calendário de folgas específicas por staff (input `type="date"` + motivo + botão adicionar/remover).
- **Isolamento dos parceiros:** parceiros (role `parceiro`) **não aparecem** nesta tabela — são geridos em `/gestor/parceiros`.

### `/gestor/calendario` (Client Component) — Folgas e Férias (v1.11.0)
- `useEffect` carrega em paralelo: `adminGet('/api/gestor/ausencias?futuras=true')` + `adminGet('/api/gestor/equipa')` (para popular o select de funcionários, filtrado a staff+manager).
- **Formulário "Marcar Ausência"** no topo: select Funcionário, Data de Início, Data de Fim, select Tipo (Folga/Férias), Notas (opcional), botão "Agendar" → `adminPost`.
- **Tabela** de ausências agendadas: Funcionário, Tipo (Badge com ícone Plane/Sun), Período (datas formatadas pt-PT), Notas, Ações.
- **Eliminar**: botão 🗑️ por linha → `adminDelete` com otimismo (remove da UI imediatamente, reverte se falhar).
- Validações no cliente: funcionário + datas obrigatórios; `data_fim >= data_inicio`.
- Tipo `AusenciaDTO` + `TipoAusencia` em `lib/api.ts`.
- **Integração com o load balancer**: as ausências registadas aqui excluem automaticamente o staff da atribuição automática de tarefas.

#### Prioridade Visual de Ausências (commit `2984270`)
- Na vista **Equipa**, a função `estadoDia(membro, data)` foi **reordenada**: ausências (vermelho) têm agora prioridade **ABSOLUTA** sobre tarefas (azul).
- Antes, um staff com tarefa atribuída + ausência nesse dia aparecia a azul (tarefa). Agora aparece a vermelho (ausência).
- O gestor vê **imediatamente** quem está de férias/folga, mesmo que tenha tarefas atribuídas nesse dia.
- Ordem da verificação: (1) ausência → vermelho; (2) tarefa atribuída → azul; (3) sem nada → default.

### `/gestor/ausencias` (Client Component) — Tabs: Ausências + Dias de Folga (commit `2984270`)
A página foi redesenhada com `<Tabs>` (shadcn) e duas vistas:

- **Separador "Ausências"** (conteúdo existente): lista as ausências/folgas agendadas em tabela (Funcionário, Tipo, Período, Notas, Ações) + botão "Marcar Ausência".
- **Separador "Dias de Folga"** (NOVO): Card que lista o staff ativo com os seus `dias_folga` (dia da semana de folga fixa, ex.: "Segunda-feira") como **Badges** abreviados ("Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom").
  - Vê-se rapidamente quem tem que dia de folga rotativa semanal.
  - Editável em `/gestor/equipa` (campo `dias_folga` no modal de edição).

#### Remoção de ferramentas de dev (commit `2984270`)
- ❌ Card de **"Diagnóstico de ausências"** — removido (era um utilitário técnico de desenvolvimento para inspeção de estado).
- ❌ Botão **"Reaplicar ausência"** — removido (era um utilitário de correção de ausências órfãs durante o desenvolvimento).
- Estas ferramentas não fazem sentido em produção e foram limpas da UI.

---

## 12. Proteção de Rotas (v1.5.0)

A proteção de rotas usa **duas camadas complementares**:

### 12.1 `src/middleware.ts` (camada servidor / Edge)
Executado antes de renderizar qualquer página. Lê o cookie `all2gether_token` (definido por `lib/auth.ts` após login):

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
O token passou a ser guardado num **cookie** (`all2gether_token`, SameSite=Lax, 7 dias) em vez de localStorage, porque o `middleware.ts` (Edge) só consegue ler cookies, não localStorage. Mantém-se localStorage como backup. Funções: `guardarToken`, `lerToken`, `removerToken`, `lerUtilizadorDoToken`, `estaAutenticado`, `rotaPorRole`.

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
| v1.2.0  | 1.2.0  | Integração com a API real na secção Propriedades: `lib/api.ts` (helpers `adminGet`/`adminPost` + `EMPRESA_ID` placeholder via header `x-empresa-id`); `/admin/propriedades` convertido em Client Component com `useEffect` (GET), tabela HTML (Nome, Tempo, Estado) e formulário inline de criação (POST + refresh automático). Componente UI `Input`. Mock-data abandonado nesta secção. |
| v1.2.1  | 1.2.1  | `EMPRESA_ID` preenchido com o ID real do “Cliente Zero” (`6a400c9009e37b27fe0bc362`) devolvido por `GET /api/admin/setup`. Placeholder `COLA_AQUI_O_ID` removido. |
| v1.3.0  | 1.3.0  | **Rebranding Premium:** primary mudada de emerald-600 → Azul Marinho Premium (`blue-950`); `--radius` reduzido de `0.5rem` → `0.3rem` (visual "sharp"); `Card` e `Button` com `shadow-sm` + borders hairline (`border-border/60`); landing page reescrita (gradiente verde removido, fundo limpo com padrão de pontos, tipografia `font-light`/`font-semibold`, cartões com elevação no hover `hover:-translate-y-0.5`). |
| v1.4.0  | 1.4.0  | **Autenticação JWT:** `lib/auth.ts` (guardar/ler/remover token + descodificar payload + `rotaPorRole`); `lib/api.ts` atualizado para enviar `Authorization: Bearer <token>` (com fallback legacy `x-empresa-id` e limpeza de token em `401`); nova rota `/login` (ecrã minimalista premium, `POST /api/auth/login`, redirect admin→`/admin` / staff→`/staff`). |
| v1.5.0  | 1.5.0  | **Proteção de rotas + landing simplificada:** `middleware.ts` (Edge) protege `/admin/**` e `/staff/**` (sem token → `/login?from=`), redireciona autenticados de `/` e `/login`, e valida role por área; `lib/auth.ts` passou a guardar token em **cookie** (middleware lê) em vez de localStorage; `components/auth/route-guard.tsx` (2ª camada client-side) aplicado nos layouts admin/staff; landing page simplificada (removidos cartões Admin/Staff, 1 botão 'Entrar na Plataforma' → `/login`); `/login` lê `?from=` e redireciona autenticados via `useEffect`. |
| v1.6.0  | 1.6.0  | **Novo role `manager` (Responsável de Limpezas):** tipo `Role = admin \| manager \| staff` em `lib/auth.ts`, `lib/api.ts`, `middleware.ts`, `route-guard.tsx`; `rotaPorRole` atualizada (manager → `/manager`); nova área `/manager` (layout + `manager-sidebar.tsx` + dashboard com tarefas + equipa + placeholders `/manager/tarefas` e `/manager/equipa`); `middleware.ts` protege `/manager/**`; `mock-data` atualizado com role manager + membro manager na equipa; dashboard admin inclui managers na equipa operacional. |
| v1.7.0  | 1.7.0  | **Rebranding Premium Dourado:** primary mudada de azul marinho (`blue-950`) → Dourado/Areia (`hsl(43 74% 49%)`); `--radius` reduzido de `0.3rem` → `0.25rem` (ainda mais "afiado"); `--muted`/`--secondary`/`--accent` = `210 40% 96%` (cinza super suave); `--border`/`--input` = `214.3 31.8% 91.4%`; dark mode luxuoso (fundo escuro + dourado brilhante `43 74% 55%`); `Button` default: removido `hover:shadow-md` (visual flat); landing page: botão maior e elegante (`h-12 px-10 tracking-wide`). Inspirado em All2Gether. |
| v1.8.0  | 1.8.0  | **Gestão de Equipa (`/admin/equipa`):** convertido em Client Component — `useEffect` chama `GET /api/admin/equipa` (JWT); tabela HTML (Nome, Email, Role com Badge, Estado); botão "Adicionar Funcionário" abre formulário inline (Nome, Email, Password, Role select); `POST /api/admin/equipa` cria utilizador (bcrypt no backend), limpa formulário e atualiza tabela. Tipo `UtilizadorDTO` + `Role` em `lib/api.ts`. |
| v1.9.0  | 1.9.0  | **CRUD completo de Utilizadores (`/admin/equipa`):** coluna "Ações" com 3 botões por linha — Editar (✏️ abre modal Dialog com Nome/Email/Role/Nova Password opcional → `PUT`), Ativar/Desativar (⏻ → `PATCH /:id/estado` com otimismo), Eliminar (🗑️ abre modal de confirmação → `DELETE`). Helpers `adminPut`/`adminPatch`/`adminDelete` em `lib/api.ts`. Componente `Dialog` (shadcn, sem Radix) em `components/ui/dialog.tsx`. |
| v1.10.0 | 1.10.0 | **Segurança hierárquica + Responsável:** `UtilizadorDTO` com `responsavel_id` + `responsavel` (populado); dropdown de Role nos formulários de criar/editar **sem opção Admin** (só Staff/Responsável); novo select **Responsável** populado com utilizadores admin+manager (exclui o próprio utilizador na edição); nova coluna **Responsável** na tabela; linhas de admin são **só de leitura** (botões Editar/Ativar/Eliminar escondidos, mostram "—"). Reflete regras 403 do backend. |
| v1.11.0 | 1.11.0 | **Calendário de Folgas e Férias (`/admin/calendario`):** convertido em Client Component — formulário "Marcar Ausência" (Funcionário select, Data Início/Fim, Tipo Folga/Férias, Notas) → `POST /api/admin/ausencias`; tabela de ausências (Funcionário, Tipo com Badge+ícone, Período formatado pt-PT, Notas, Eliminar); botão 🗑️ com otimismo. Tipo `AusenciaDTO` + `TipoAusencia` em `lib/api.ts`. Ausências integram com o load balancer (excluem staff da atribuição automática). |
| v1.12.0 | 1.12.0 | **Remoção do fallback legacy `x-empresa-id`:** `lib/api.ts` — removida constante `EMPRESA_ID` e fallback `x-empresa-id` do `adminHeaders`. Agora envia **apenas** `Authorization: Bearer <token>` se houver token; sem token, não envia header (backend devolve 401). Comentário em `propriedades/page.tsx` atualizado. Alinha com o backend v1.10.0 (middleware auth estrito). |
| v1.13.0 | 1.13.0 | **Cookie seguro (anti-XSS):** `lib/auth.ts` — cookie com `SameSite=Strict` (anti-CSRF) + `Secure` (apenas HTTPS); `localStorage` **completamente removido** (era vulnerável a XSS — script injetado conseguiria ler o token). Token vive agora **exclusivamente** no cookie. `guardarToken`/`removerToken` operam apenas o cookie. `deleteCookie` atualizado com mesmas flags para garantir sobreposição. |
| Prompt 95 | — | **Ecrã de Férias/Ausências + Staff Preferencial + Detalhes da Reserva (Fase 1.5):** (1) `/gestor/ausencias` deixou de ser redirect e passou a **tabela definitiva** com TODAS as ausências da empresa (sem filtros de estado): colunas Funcionário, Tipo (ícone), Período, Estado (Badge), Notas, Ações (Eliminar com modal de confirmação → `DELETE /api/gestor/ausencias/:id` com otimismo). O menu lateral já apontava para `/gestor/ausencias` (mantido). (2) `/gestor/propriedades` modal de Editar: novo **select de Funcionário Preferencial** (carrega staff ativo via `GET /api/gestor/equipa`, filtra `role==='staff'`); grava via `PUT /api/gestor/propriedades/:id` com `funcionario_preferencial_id` (string vazia → null). `PropriedadeDTO` + `TarefaMock` atualizados em `lib/api.ts` com `funcionario_preferencial_id` e `detalhes_reserva`. (3) Novo componente partilhado `components/detalhes-reserva-card.tsx` — Card de destaque com Check-in, Check-out, Hóspedes (pax) e Nome do Hóspede; só renderiza se `detalhes_reserva` existir. Usado em: `components/staff/detalhe-tarefa-client.tsx` (topo do detalhe da tarefa no mobile do staff) e novo `components/gestor/detalhe-tarefa-modal.tsx` (modal aberto via botão Eye na tabela de tarefas do gestor, mostra propriedade/tipo/estado/data/staff/observações/avarias + o card de detalhes_reserva). Build + lint + tsc ✓. |
| Ajuste | — | **Ocultar staff indisponíveis do dropdown de atribuição:** o modal "Atribuir Tarefa" (`/gestor/tarefas`) e o modal de reatribuição do Calendário (`/gestor/calendario`) deixaram de mostrar os staff indisponíveis (férias/doença/ausência nesse dia) como `<option disabled>` e passam a **omitir** da lista via `.filter(u => !indisponiveis.some(i => i.utilizador_id === u._id))`. A lista só contém quem pode realmente receber a tarefa. O aviso amarelo abaixo do select foi atualizado de "não podem receber tarefas" para "foram omitidos da lista". Antes (v1.59.0/Prompt 81) os indisponíveis apareciam a cinzento/desativados; agora não aparecem. Build + lint + tsc ✓. |
| Prompt 99 | — | **Ecrã de Relatório no Calendário — Vista Tabela + Exportar Excel:** `/gestor/calendario` ganhou um **Toggle de vistas** no cabeçalho (Vista Calendário / Vista Tabela) e um botão **Exportar Excel**. (1) **Toggle:** `vista: "calendario" \| "tabela"` — quando "tabela" está ativo, o FullCalendar é escondido e mostra-se uma Data Table com as tarefas do período/filtros selecionados (excluindo ausências/folgas que só fazem sentido no calendário), ordenadas por data crescente. Colunas: Data (DD/MM/YYYY), Propriedade, Reserva (`In: [checkin] Out: [checkout] - [pax] pax` via `detalhes_reserva`), Funcionário (nome ou "Por Atribuir" a amarelo), Horário (`HH:mm - HH:mm`), Estado (Badge colorido: por_atribuir=destructive, atribuida=default, em_curso=warning, concluida=success, cancelada=outline). Clicar numa linha abre o modal de detalhe existente. (2) **Exportar Excel:** botão que instala a lib `xlsx` (^0.18.5); ao clicar, constrói um Workbook com `XLSX.utils.json_to_sheet` (colunas Data/Propriedade/Reserva/Funcionário/Horário/Estado, larguras definidas via `!cols`) e faz `XLSX.writeFile(wb, "Relatorio_Limpezas.xlsx")`. `xlsx` importado dinamicamente (`await import("xlsx")`) para não entrar no bundle inicial. Todos os campos vão como texto (datas DD/MM/YYYY) — o Excel interpreta como texto. Interface `TarefaCalendario` alargada com `detalhes_reserva`. Build + lint + tsc ✓. |
| Prompt 100 | — | **Garantir os Dados do Excel (robustez):** (1) Novo helper `formatarReservaExcel` (variante do `formatarReserva`) que devolve **string vazia** quando a tarefa não tem `detalhes_reserva` (ex: manutenção) — a célula do Excel fica em branco em vez de "—". Os sub-campos em falta (checkin/checkout/pax) também ficam vazios; se nenhum estiver preenchido, devolve vazio (não "In:  Out:  - "). A `exportarExcel` passou a usar `formatarReservaExcel` e a deixar em branco Propriedade/Horário em falta. (2) `ESTADO_LABEL_TAB` atualizado: `em_curso` passa a "Em Curso" (C maiúsculo, capitalização de título) para corresponder ao pedido do prompt; restantes estados já estavam traduzidos (Por Atribuir, Atribuída, Concluída, Cancelada). Backend: confirmado via 2 novos testes que o `GET /api/gestor/calendario/dados` já devolve `detalhes_reserva` (usa `.lean()` sem `.select()`). Build + lint + tsc ✓; backend 125/125 ✓. |
| Prompt 101 | — | **Controlo de Utilizadores no Painel de Admin (Fullstack):** `/admin` ganhou um botão **"Gerir Utilizadores"** (ícone Users) por cada empresa na tabela. Ao clicar, abre um **modal** que lista todos os utilizadores (gestores + staff) dessa empresa via `GET /api/admin/empresas/:empresaId/utilizadores` (proxy route). Tabela com colunas Nome, Email, Role (Badge Gestor/Staff), Estado (Badge Ativo/Inativo) e um botão **Ativar/Desativar** (ícone Power) que faz `PATCH .../utilizadores/:id/estado` com otimismo. Botão **"Criar Novo Gestor"** no fundo do modal abre um mini-formulário (Nome, Email, Password) que faz `POST .../utilizadores` com `role: 'gestor'` — para empresas que ficaram com 0 gestores. Novos proxy routes: `api/admin/empresas/[empresaId]/utilizadores/route.ts` (GET+POST) e `api/admin/empresas/[empresaId]/utilizadores/[utilizadorId]/estado/route.ts` (PATCH). Tipo `UtilizadorEmpresaDTO`. Build + lint + tsc ✓. |
| Prompt 113 | — | **Mega Prompt de Correção (Alpha):** (1) **Loop 401 + Layouts** — `lib/auth.ts` `lerUtilizador()` deixou de fazer `window.location.href=/login` como side-effect em 401 (era pura, devolve `null`); adicionado cache **in-flight** (callers paralelos partilham a mesma Promise → 1 fetch em vez de N). `components/auth/route-guard.tsx` — redirect único com flag `redirecionado`; trata role errado (→ painel certo). `gestor/layout.tsx` continua com `AdminSidebar mode="gestor"` (nunca mostra menu de admin). (2) **Banner de impersonação** — novo client component `components/gestor/impersonation-banner.tsx` (lê `sessionStorage` em `useEffect`, evita problemas de hidratação); botão **VERMELHO "Voltar a Admin"** que chama `POST /api/auth/exit-impersonation` (restaura cookie de admin guardado), limpa `sessionStorage` e vai para `/admin`. `api/admin/impersonar/[id]/route.ts` guarda o token de admin num cookie separado `all2gether_admin_token` antes de o substituir; novo `api/auth/exit-impersonation/route.ts` troca de volta; `login` e `logout` limpam o cookie de backup. (3) **Cockpit Admin limpo** — `/admin/sistema` reescrito: removidas as tabs e todas as opções de Sincronizações/Webhooks/Configuração (nome empresa); fica só Forçar Cron Jobs globais + Push de teste + Hard Reset, com um aviso a apontar para `/gestor/configuracoes`. (4) **Calendário + timezone** — botão **"Nova Tarefa"** no cabeçalho de `/gestor/calendario` abre um modal de criação (Propriedade, Data, Tempo, Tipo, Staff opcional). Helpers novos em `lib/utils.ts`: `paraIsoMeiaNoiteLocal("YYYY-MM-DD")` (envia meia-noite LOCAL como ISO) e `temHoraReal(iso)` (hora local ≥ 8). Tarefas sem hora real (criadas só com data) são renderizadas como **all-day** no FullCalendar (visíveis na faixa all-day das vistas semanal/diária em vez de invisíveis abaixo do slotMinTime 08:00); na Vista Tabela, o horário mostra "—". `tarefas/page.tsx` e o novo modal do calendário enviam `paraIsoMeiaNoiteLocal(form.data)`. (5) **Bloqueio de tarefa concluída** — `components/staff/detalhe-tarefa-client.tsx`: se `tarefa.estado === "concluida"`, desativa checkboxes (`disabled`), textarea, e esconde botões Concluir/Atraso/Avaria (mostra banner "Concluída"); pré-marca todos os itens. Modal do calendário: botão "Reatribuir" e dropdown de staff `disabled` quando concluída. (6) `/gestor/propriedades` ganhou botão **"Checklist Padrão"** (ícone ListChecks) que aplica o checklist padrão a todas as propriedades via `POST /api/gestor/propriedades/default-checklist` (com `confirm`). Build + lint + tsc ✓; backend 136/136 ✓. |
| Prompt 114 | — | **Notificações In-App, Bugs Alpha e Lógica de Distâncias (frontend):** (1) **Push Notifications** — `components/staff/push-notification-setup.tsx` (re-exportado em `components/gestor/`) já faz `pushManager.subscribe` + `POST /api/auth/me/push-subscribe` (via catch-all proxy). Confirmado funcional. (2) **Centro de Notificações (O Sino)** — novo `components/notification-bell.tsx`: ícone Bell com badge vermelho (count de não-lidas), dropdown com lista, polling a 30s, marca todas como lidas ao abrir (`PATCH /marcar-lidas`). Renderizado no header do `GestorSidebar` (desktop + mobile) e no header do `/staff` (ao lado do logout). Usa `/api/auth/me/notificacoes/*` (via catch-all proxy). (3) **Isolamento Menu Admin** — `/gestor/layout.tsx` deixou de importar `AdminSidebar` (partilhado). Novo `components/gestor/gestor-sidebar.tsx` dedicado (não importa nada de admin); o layout usa-o. Itens: Dashboard, Propriedades, Tarefas, Equipa, Ausências, Calendário, Relatórios, Webhooks, Configurações + Sino + Tema + Logout. (4) **Staff ativo** — `/gestor/tarefas/page.tsx` e `/gestor/calendario/page.tsx` filtram `u.role === "staff" && u.ativo === true` (antes só role). (5) **Capacidade destacada** — `TarefaMock` (lib/api.ts) + `TarefaDetalheGestor` ganham `capacidade_hospedes`. `components/gestor/detalhe-tarefa-modal.tsx` e `components/staff/detalhe-tarefa-client.tsx` mostram badge âmbar "Lotação máxima: N hóspede(s)" (ícone Users). `/staff/tarefas/[id]/page.tsx` passa `capacidade_hospedes` do populate. (6) **Toasts de warning** — `/gestor/propriedades/page.tsx` (geocoding falhou ao criar/editar), `/gestor/tarefas/page.tsx` (distância >15km ao criar/atribuir) e `/gestor/calendario/page.tsx` (distância ao criar/reatribuir) capturam `res.warning` e mostram Card âmbar (`border-amber-500/50 bg-amber-50`). Lint + tsc + build ✓; backend 143/143 ✓. |
| Prompt 115 | — | **Separação ABSOLUTA de menus/layouts + fix loop 401 (frontend):** (1) `components/gestor/gestor-sidebar.tsx` reescrito como componente **dedicado** — `gestorNavItems` com APENAS 8 items operacionais (Dashboard, Calendário, Tarefas, Propriedades, Equipa, Ausências, Relatórios, Configurações); brand label "Gestor"; **nenhum** link para Sistema/Empresas/Admin. (2) `components/admin-sidebar.tsx` reescrito **sem `mode` prop** e sem `gestorNavItems` partilhado — `adminNavItems` com APENAS 3 items (Empresas, Sistema/Webhooks, Webhooks); componente dedicado, não importa nada do gestor. (3) `admin/layout.tsx` usa `<AdminSidebar />` (sem `mode`); `gestor/layout.tsx` usa `<GestorSidebar />` — ambos importam EXCLUSIVAMENTE o seu sidebar. (4) `components/auth/route-guard.tsx` reescrito: em 401 faz `limparCacheAuth()` + `fazerLogout()` (POST `/api/auth/logout`) + `window.location.href = "/login"` (redirect HARD) em vez de `router.replace` (soft); sem retry em 401; role errado → redirect HARD para o painel certo. Elimina o re-mount/re-fetch em cascata do loop 401. Lint ✓ · tsc ✓ · build ✓ (middleware 26.8kB). |
| Prompt 116 | — | **Fundação SaaS (frontend):** (1) `/admin` ganhou gestões de empresa — tabela de empresas com botões para criar, ativar/suspender (`PATCH .../toggle-status`) e hard-reset scoped (`POST .../hard-reset`). (2) Isolamento visual admin vs gestor consolidado (a separação ABSOLUTA do Prompt 115 garante que o gestor não vê nada de admin). (3) Modal "Nova Tarefa" (`/gestor/tarefas` + `/gestor/calendario`) alargado com campos de `hora`, `check_in`, `check_out` e `hospedes` (nome + nº) que populam `detalhes_reserva`. (4) `Propriedade.observacoes` editável no formulário de propriedade. |
| Prompt 117 | — | **Remodelar UI/UX — isolar Super Admin do Gestor:** (1) Nova **gaveta da empresa** em `/admin/empresas/[id]` — página de gestão dedicada por empresa com botões **Apagar** (`DELETE .../empresas/:id`), **Suspender/Ativar** (`PATCH .../toggle-status`) e **Gerir Config** (abre secção com nome, NIF via `GET/PUT .../config`). (2) **Geocoding warning inline** — ao criar/editar propriedade, se o Nominatim falhar, mostra aviso âmbar inline no formulário (em vez de toast solto) a aconselhar simplificar a morada. (3) **Nova Tarefa com hora/hóspedes** — modal de criação alargado (hora, check-in/out, nome + nº de hóspedes → `detalhes_reserva`). Lint + tsc + build ✓. |
| Prompt 118 | — | **UX Staff, Notificações e Exportação PDF:** (1) **Staff dashboard agrupado por dia** — `/staff` reorganizado: tarefas agrupadas por data (hoje, amanhã, ...) em vez de lista única. (2) Labels passaram a **"Nº Hóspedes"** e **"Nome Hóspede"**; **Data da Limpeza** destacada no topo de cada cartão. (3) `components/notification-bell.tsx` com `max-h-[80vh]` e scroll interno (lista longa não estoura o viewport). (4) Push notifications passaram a mostrar **feedback de sucesso/erro** ao subscrever (toast). (5) **Exportar PDF** — novo botão "Exportar PDF" no `/staff` e no relatório do gestor que usa `window.print()` (estilos `@media print` dedicados) para gerar PDF via o diálogo de impressão do browser. |
| Prompt Extra | — | **Vacina Anti-Safari (parsing de datas iOS/Safari):** novos helpers em `lib/utils.ts`: **`parsearDataSegura(valor)`** (aceita `YYYY-MM-DD`, `DD/MM/YYYY`, ISO com/sem timezone; devolve `Date` válido ou `null` — robusto ao parser do Safari que devolve `Invalid Date` em formatos não-ISO) e **`extrairHoraISO(iso)`** (extrai `HH:mm` de uma string ISO sem depender de `new Date()` — evita o shift de fuso do Safari). Substituídas todas as construções `new Date("YYYY-MM-DD")` e formatações baseadas em `Date` nos componentes de staff/gestor pelos helpers seguros. Resolveu datas a aparecer como `Invalid Date` / `NaN/NaN/NaN` no iOS Safari. |
| Prompt 119 | — | **Resiliência PWA (Service Worker):** `next-pwa` configurado com `skipWaiting: true` + `clientsClaim: true` (nova versão do SW assume o controlo imediatamente). **Runtime caching** com estratégia `NetworkFirst` para os chunks JS (`/_next/static/chunks/`) — fallback para cache se a rede falhar (mitiga `ChunkLoadError`). **Handler global de `ChunkLoadError`** no cliente que faz reload limpo (uma só vez) + limpeza de caches antigos do SW ao ativar. Resolveu ecrã branco em produção após deploy com chunks obsoletos em cache. |
| Prompt 120 | — | **Remover loop de reload + fix hidratação de datas:** (1) **Remoção do Script agressivo** — o handler de `ChunkLoadError` do Prompt 119 estava a entrar em loop de reload (recarregava indefinidamente se o chunk continuasse a falhar). Substituído por um guard com `sessionStorage` (só tenta reload 1x por sessão) e remoção do `window.location.reload` em cascata. (2) **`mounted` guard na staff page** — `/staff/page.tsx` passou a verificar se o componente ainda está montado (`isMountedRef`) antes de fazer `setState` após fetch assíncrono (evita warnings de hidratação e updates em componentes desmontados). Fix de datas trocadas na hidratação inicial (server vs client). |
| Prompt 121 | — | **Reposição de fábrica do layout + next.config minimalista:** (1) **Reposição de fábrica do layout** — revertidos overrides CSS agressivos que causavam inconsistências visuais (reset do `globals.css` ao estado base do Tailwind/shadcn); removidos estilos experimentais acumulados. (2) `next.config.mjs` **minimalista** — removidas configurações experimentais de PWA/webpack que conflituavam com o `next-pwa`; mantido apenas o estritamente necessário (`next-pwa` wrapper + `reactStrictMode`). Estabilizou o build em produção. |
| Prompt 122 | — | **Limpeza Admin + Soft Delete (Lixeira de Empresas) — frontend:** (1) `/admin` ganhou **Tabs "Ativas" / "Reciclagem"** — a tab Reciclagem lista empresas eliminadas (`apagada: true`) com botão "Restaurar" (`PATCH .../restaurar`). A tab Ativas lista as empresas ativas (`apagada: false`) com botão "Apagar" (`DELETE .../empresas/:id` soft delete). (2) `AdminSidebar` simplificado para mostrar **só Empresas** (Webhooks passou para dentro da gaveta da empresa `/admin/empresas/[id]`). (3) A gaveta da empresa integra agora as ações de sincronização (sincronizar-propriedades, sincronizar-reservas, registrar-webhooks) via os novos endpoints de Super Admin. |
| Prompt 123 | — | **Soft block de conflitos (frontend):** `/gestor/tarefas/page.tsx` (criar + atribuir) e `/gestor/calendario/page.tsx` (criar + reatribuir) passaram a capturar `res.warning` de sobreposição horária (que agora vem como `200` em vez de `409`) e mostrar Card âmbar com o **tempo de viagem** estimado. O warning é **não-bloqueante** — o gestor pode prosseguir. `Propriedade.observacoes` exposto no detalhe de tarefa (`detalhe-tarefa-modal.tsx` + `detalhe-tarefa-client.tsx`). |
| Prompt 124 | — | **Interface móvel, navegação dias, relatório IA, CSS sino:** (1) **Staff navegação por dias** — `/staff` ganhou setas ‹ › para navegar entre dias (hoje ←/→ amanhã, ontem, etc.) em vez de mostrar só o dia atual. (2) **IA resumo exportável como PDF** — botão "Exportar PDF" no `/gestor/relatorios` que consome `POST /api/gestor/relatorios/ai-summary` e gera PDF via `html2pdf.js`. (3) **CSS sino mobile** — `NotificationBell` redesenhado para mobile (dropdown full-width, posicionamento fixo, z-index corrigido para não ficar por baixo de modais). (4) **Task-card morada** — cartões de tarefa do staff passaram a mostrar a morada da propriedade (antes só o nome). |
| Prompt 125 | — | **Gemini SDK, fuso manutenção local, soft block, observacoes Propriedade (frontend):** o resumo IA (`/gestor/relatorios`) passou a usar o endpoint consolidado com Gemini SDK. `Propriedade.observacoes` passível de edição no formulário de `/gestor/propriedades`. Soft block de conflitos (warning não-bloqueante) mantido nas páginas de tarefas e calendário. |
| Prompt 126 | — | **UX logística, PDF fix, frontend responsivo, notificações:** (1) **Double-check logístico** — ao criar tarefa sobreposta, modal de confirmação com botões **"Forçar Agendamento"** (ignora o warning de conflito) e **"Confirmar Morada"** (re-confirma a morada antes de agendar — previne tarefas com morada errada). (2) PDF do relatório IA com **delay** para garantir renderização completa do `html2pdf` antes do download. (3) Nova página **`/gestor/notificacoes`** — vista full-page do centro de notificações (além do sino dropdown). (4) Frontend responsivo: ajustes de breakpoints em tabelas e modais para tablet/mobile. |
| Prompt 127 | — | **Fix timezone (time shift), AlertDialog cancelar, loading relatório:** (1) **Fix timezone (time shift)** — `extrairHoraISO` (em `lib/utils.ts`) reescrito para **não usar `new Date()`** (que aplicava fuso e deslocava a hora mostrada). Agora faz parse direto da string ISO (`"YYYY-MM-DDTHH:mm"`) — a hora exibida é a armazenada, sem shift. Resolveu tarefas a aparecerem 1h adiantadas/atrasadas. (2) **AlertDialog "Cancelar"** — modais de confirmação (eliminar, suspender) passaram a usar `AlertDialog` (shadcn) com botão explícito "Cancelar" que fecha sem ação (antes um clique fora podia confirmar). (3) **Loading do relatório IA** — spinner visível durante a geração do resumo (impede duplo-click). |
| Prompt 128 | — | **Blindagem backend (frontend sem alterações diretas):** o fix de fuso Portugal e a blindagem do Gemini foram no backend. O frontend beneficiou-se indiretamente (resumo IA nunca devolve 500 — fallback gracioso). Sem alterações de código frontend. |
| Prompt 129 | — | **Fix calendário timezone + SW não interceta /api/ (frontend):** (1) **Calendário timezone** — eventos do FullCalendar passam a ser construídos com **strings locais sem sufixo `Z`** (`"YYYY-MM-DDTHH:mm:ss"`) em vez de ISO UTC (`...Z`) — o calendar interpreta como hora local e não aplica conversão de fuso. Resolveu eventos a aparecerem no dia/hora errada em fusos não-UTC. (2) **SW `publicExcludes /api/`** — o Service Worker (runtime caching) configurado para **não interceta** pedidos a `/api/` (passa sempre à rede). Antes, o `NetworkFirst` podia servir respostas cached obsoletas da API (ex.: notificações, tarefas). Garantia de dados sempre frescos do backend. |
| Prompt 130 | — | **Fix definitivo ausências (frontend sem alterações diretas):** o fix do `staffController.criarAusencia` (filtro de estado) e a remoção do índice único MongoDB foram no backend. O frontend deixou de receber `409` ao criar ausências sobrepostas — o pedido passa a `201`. Sem alterações de código frontend. |
| Prompt 131 | — | **Staff notificacoes + nome_hospede + dias anteriores (frontend):** (1) Nova página **`/staff/notificacoes`** — vista full-page do centro de notificações do staff (além do sino dropdown no header); consome `/api/auth/me/notificacoes/*`. (2) **`nome_hospede`** exibido nos cartões de tarefa do `/staff` e no detalhe (`detalhe-tarefa-client.tsx`), populado a partir de `detalhes_reserva.nome_hospede`. (3) **Dias anteriores (30 dias)** — `/staff` passou a permitir navegar não só para a frente mas também **até 30 dias para trás** (histórico de tarefas concluídas) via as setas ‹ ›, além dos dias futuros. |
| Prompt 132 | — | **Cancelamento de ausências (frontend):** o botão "Cancelar" nas ausências passou a fazer `PATCH /api/staff/ausencias/:id/cancelar` (soft cancel — mantém o histórico, marca `estado: 'cancelada'`) em vez de `DELETE` (que apagava o registo). Aplica-se tanto ao `/staff/ausencias` como ao `/gestor/ausencias`. |
| Prompt 133 | — | **Arquitetura de checklists dinâmicas (frontend sem alterações diretas):** o modelo `ModeloChecklist` foi criado no backend (template com secções/items). O frontend beneficiou-se via injeção on-the-fly no `minhaTarefaDetalhe` — o staff vê a checklist da propriedade mesmo em tarefas antigas sem snapshot. |
| Prompt 134 | — | **Ecrãs de configuração e interface do staff (frontend):** (1) Nova página **`/gestor/configuracoes/checklists`** — CRUD completo de modelos de checklist (criar/editar/eliminar modelos com secções e items dinâmicos). (2) Select de `modelo_checklist_id` no formulário de `/gestor/propriedades` (associa um modelo a cada propriedade). (3) `detalhe-tarefa-client.tsx` renderiza a `checklist_dinamica` por secções (em vez da checklist flat legacy), com bloqueio do botão "Concluir" até 100% dos items marcados. |
| Prompt 135 | — | **Injeção das checklists via seed (frontend sem alterações diretas):** o script `seedChecklists.js` cria 2 modelos base (Limpeza Standard + Detalhada V2) e associa-os às propriedades. O frontend mostra o botão "Correr Seed de Checklists" na gaveta da empresa (`/admin/empresas/[id]`) que faz `POST /api/admin/empresas/:id/seed-checklists`. |
| Prompt 136 | — | **Fix PDF sempre visível + abandono do html2pdf.js (frontend):** (1) O `exportarPDF` do `/gestor/relatorios` passou a usar **`window.open()` + `document.write()` + `printWindow.print()`** (diálogo de impressão nativo do browser) em vez do `html2pdf.js` (que produzia PDFs em branco). O HTML do relatório é gerado numa nova janela com estilos inline A4 (cabeçalho, KPIs, tabelas de staff/propriedades/estados, resumo IA). (2) **Removido o `PdfExportContent`** e o div de exportação residual (`position: fixed; opacity: 1; zIndex: 99998`) que estava a tornar o relatório **sempre visível** por cima da página. Removido também o `useRef` (já não há `pdfExportRef`). |
| Prompt 137 | — | **Fix nome_hospede não aparecia nos cartões do staff:** o backend já gravava `detalhes_reserva.nome_hospede` (via `criarTarefa` manual) e o detalhe da tarefa já o mostrava (`DetalhesReservaCard`). Mas a **lista de tarefas do staff** não o exibia. (1) `adaptarTarefa()` em `/staff/page.tsx` passou a repassar `detalhes_reserva` ao `TaskCard`. (2) `TaskCard` (`components/staff/task-card.tsx`) passou a mostrar uma linha destacada (ícone `User` + fundo dourado claro) com o `nome_hospede`. (3) Tabela de `/gestor/tarefas` ganhou coluna **"Hóspede"** entre Propriedade e Funcionário. |
| Prompt 138 (136 V2) | — | **Cérebro do Scheduler e Gravação da Viagem (frontend):** (1) Novo estado **`nao_atribuida`** (SLA excedido — todos os staff > 480 min). Labels "Não atribuída (SLA)" + cor vermelha `destructive` em `/gestor/tarefas`, `detalhe-tarefa-modal`, `/gestor/calendario` (paleta vermelho escuro) e `/gestor/relatorios`. Tab "Por atribuir" do `/gestor/tarefas` inclui `nao_atribuida`. (2) **Tempo de viagem** — `TarefaMock` (api.ts) ganhou `tempo_viagem_minutos`. `detalhe-tarefa-client.tsx` mostra "+Xmin viagem" (âmbar) nos metadados. `/staff/tarefas/[id]/page.tsx` repassa o campo. |
| Prompt 139 (137) | — | **O Calendário Visual (Mostrar as Viagens):** (1) **Blocos de Viagem no Calendário** — `/gestor/calendario/page.tsx` agora cria **DOIS eventos** quando `tempo_viagem_minutos > 0`: Evento A (🚗 Viagem, cinzento + borda tracejada, antes da tarefa) + Evento B (Limpeza normal). `tarefas.map` → `tarefas.flatMap`. `renderEventContent` detecta `_isViagem` e renderiza com estilo próprio. CSS `.fc-evt-viagem` / `.fc-evt-month--viagem` / `.fc-evt-block--viagem` em `globals.css`. Clicar no bloco de viagem abre o detalhe da tarefa. (2) **Badge nos detalhes** — `detalhe-tarefa-modal.tsx` (gestor) mostra "🚗 Tempo de Viagem estimado: X min" (âmbar). `task-card.tsx` (staff) mostra "🚗 Tempo de Viagem: X min" (âmbar). Interfaces `TarefaCalendario`, `TarefaReal`, `TarefaDetalheGestor` actualizadas com `tempo_viagem_minutos`. |
| Prompt 139b | — | **Fix viagens não apareciam (cálculo on-the-fly + backfill):** as tarefas existentes foram criadas antes do Prompt 138 e não tinham `tempo_viagem_minutos` preenchido. (1) `getDadosCalendario`, `minhasTarefas`, `getTarefas` e `minhaTarefaDetalhe` agora calculam `tempo_viagem_minutos` **on-the-fly** (Haversine entre a tarefa anterior do mesmo staff no mesmo dia) quando o campo está vazio. (2) Novo endpoint `POST /api/admin/backfill-tempos-viagem` + botão **"Calcular Tempos de Viagem"** na gaveta da empresa para persistir os valores na BD. |
| Prompt 140 | — | **Caixa Negra de Webhooks na gaveta da empresa:** novo componente `WebhookLogsCard` (`components/admin/webhook-logs-card.tsx`) que mostra os logs de webhooks filtrados por empresa. Inclui tabela com data/hora, evento, estado (Badge) e erro; filtros por estado; **linha expansível** (click para ver payload completo em JSON); botão "Limpar Antigos". Adicionado à gaveta da empresa (`/admin/empresas/[id]`) antes da Zona de Perigo. Backend: `WebhookLog` ganhou `empresa_id`, o webhook resolve a empresa a partir do payload, `GET /api/admin/webhook-logs` aceita `?empresa_id=`. |
| Hotfix | — | **Correção da construção do URL de destino nos proxies (anti-502):** os 9 proxy routes (`/api/gestor/*`, `/api/staff/*`, `/api/admin/*`, `/api/auth/login`, `/api/auth/me/*`, `/api/auth/sso`, `/api/admin/empresas`, `/api/admin/impersonar/:id`) partilhavam um padrão frágil — `const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "";` seguido de concatenação por template literal. Se a env var faltasse, `BACKEND_URL = ""` produzia um URL relativo que resolvia contra o próprio domínio Vercel (loop → 502 silencioso). Criado helper partilhado `lib/backend.ts` com `buildBackendUrl(path, queryString)` que: (1) normaliza a env var (trim + remoção de barras finais); (2) combina path + base com `new URL(path, base)` — tolera barras finais, valida a base, **sem protocolo hardcoded**; (3) devolve `null` se a env var faltar/for inválida. Todos os proxies passam a usar o helper e devolvem `502` com mensagem explícita `ERRO_BACKEND_NAO_CONFIGURADO` (nomeia a env var em falta) em vez do 502 genérico, para diagnóstico imediato nos logs da Vercel. **Nota operacional:** a env var `NEXT_PUBLIC_API_URL` na Vercel deve apontar para `https://all2gether-backend.onrender.com` (não `autocell-kv5g.onrender.com`, host antigo). tsc ✓ · lint ✓. |
| Hotfix (HF6) | — | **Nova página `/gestor/configuracoes/integracoes` (Integrações & Rotinas):** migra a gestão da configuração Smoobu da Nave-Mãe para o All2gether (descentralização arquitetural). Nova página `frontend/src/app/gestor/configuracoes/integracoes/page.tsx` com: (1) **Secção "Integração Smoobu"** — input password para nova API key (com toggle Substituir/Limpar), mostra chave mascarada (`••••••••1234`) se já configurada + Badge "Configurada"/"Por configurar", checkbox "Integração ativa", indicador de última sincronização, botão "Importar Propriedades" (chama `POST /api/gestor/smoobu/propriedades`). (2) **Secção "Rotinas de Sincronização"** — checkbox "Sincronização automática", select de frequência (1h/6h/12h/24h). (3) **Avisos** — toast de sucesso/erro + aviso âmbar se env var `SMOOBU_API_KEY` ativa (a chave da BD tem prioridade). (4) **Item sidebar "Integrações"** (ícone `Plug`) adicionado ao `gestor-sidebar.tsx`. Comunica com `GET/PUT /api/gestor/configuracoes/integracoes` (novo endpoint backend HF6). A API key NUNCA é exposta em claro no GET (só mascarada + booleano `configurado`). Adaptado aos componentes UI disponíveis (sem Switch/Label/Select shadcn — usa Checkbox + `<label>` + `<select>` nativos). tsc 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF10) | — | **Interface de gestão de folgas rotativas para o staff:** nova secção "Folgas Específicas / Rotativas" no modal de edição de funcionário (`/gestor/equipa`). (1) **Tipos TypeScript** — `UtilizadorDTO` em `lib/api.ts` ganhou `folgas_rotativas?: { _id?: string; data: string \| Date; motivo: string }[]`. (2) **Backend** — `atualizarMembroEquipa` (`gestorController.js`) aceita `folgas_rotativas` no `req.body`: valida array, normaliza datas (`new Date(fr.data)`), trunca motivo a 200 chars, ordena por data ascendente, substituição total (não append). (3) **UI** — secção no modal de edição com: formulário para adicionar (input `type="date"` + input de motivo + botão "Adicionar" com ícone `Plus`); lista de folgas agendadas ordenadas por data (formato `dd/MM/yyyy` via `date-fns` com locale `pt`), cada item com data + motivo + botão remover (ícone `Trash2`, `aria-label`); datas passadas mostradas com `opacity-50` + "(passada)"; estado vazio "Nenhuma folga específica agendada."; `max-h-48 overflow-y-auto` na lista. (4) **Funcionalidades** — `adicionarFolgaRotativa()` valida data obrigatória + evita duplicados; `removerFolgaRotativa(data)` filtra por data; `abrirEdicao` normaliza datas ISO do backend para `YYYY-MM-DD` (formato do input); `handleEditar` envia o array completo no PUT. Ícone `Calendar` adicionado aos imports do lucide-react. tsc 0 erros ✓ · `next lint` limpo ✓ · backend 111/111 testes ✓. |
| Commit `16ad06a` | — | **Acesso direto do admin + remoção do `<AutoImpersonarEmpresa/>`:** o componente `<AutoImpersonarEmpresa/>` foi **REMOVIDO** do `gestor/layout.tsx`. O Super Admin (role `admin`) aterra **diretamente** na vista operacional `/gestor` sem fluxo de impersonação — o seu `empresa_id` aponta para a empresa operacional "All2gether" (renomeada via rota `/api/cleanup-final` a partir de "All2gether (Sistema)"). As queries `req.user.empresa_id` devolvem dados reais sem necessidade de troca de token. O `<ImpersonationBanner/>` mantém-se no layout **por segurança** (sessões antigas com flag `all2gether_impersonating` ativa podem sair), mas para novas sessões o banner não aparece. Limpeza de rotas de setup temporárias. Resolveu bugs de cache/sessionStorage do fluxo legacy de auto-impersonação. |
| Commit `6d8bca1` | — | **Backend aceita role 'parceiro' + clarificação UI:** o `gestorController.criarMembroEquipa` passou a aceitar `role: 'parceiro'` (além de `staff` e `gestor`). A UI de criação/edição em `/gestor/parceiros` envia `role: 'parceiro'` no payload. Página `/gestor/parceiros` consome `GET /api/gestor/parceiros` (lista filtrada) e reutiliza `POST/PUT/PATCH /api/gestor/equipa` para criar/editar/toggle. |
| Commit `c30edde` | — | **Parceiros isolados + soft-delete com desatribuição futura + moradas estruturadas:** (1) **Nova página `/gestor/parceiros`** — CRUD completo de parceiros B2B (role 'parceiro'), isolada da `/gestor/equipa`. Tabela com Nome, Email, Telefone, NIF, Observações, Estado. Dialogs de criar/editar. Item sidebar "Parceiros" (ícone `Handshake`). (2) **Soft-delete com desatribuição futura** — ao desativar/apagar um parceiro, as propriedades associadas ficam com `parceiro_id = null` (ou reatribuídas à empresa operacional "All2gether"). (3) **Morada estruturada** — formulários de propriedade ganharam campos `rua` / `codigo_postal` / `cidade` (opcionais; substituem `morada` string se preenchidos). (4) **Correções admin** — pequenas correções de permissões para o admin em modo acesso direto. |
| Commit `97c6832` | — | **Google Maps integration + auto-reatribuição em férias + hard-delete para admin:** (1) **Botão "Abrir no Google Maps"** — ícone `Navigation` (lucide-react) junto à morada em `/gestor/propriedades` (tabela), `task-card.tsx` (staff, lista de tarefas) e `detalhe-tarefa-client.tsx` (staff, detalhe). URL universal `https://www.google.com/maps/search/?api=1&query=...` — usa coordenadas lat/lng se existirem, senão a morada string. (2) **Auto-reatribuição em férias** — quando o staff entra de férias, as suas tarefas futuras são reatribuídas automaticamente a outro staff disponível (backend); o frontend mostra o novo atribuído. (3) **Hard-delete para admin** — botão "Eliminar Definitivamente" (ícone `Trash2`) em `/gestor/propriedades`, visível só para `userRole === 'admin'` (via `lerUtilizador()`), com Dialog de confirmação de irreversibilidade. Endpoint: `DELETE /api/gestor/propriedades/:id?hard=true`. (4) Ajustes UI menores. |
| Commit `f18545d` | — | **Auto-reatribuição em férias + hard-delete para admin + agrupa folgas + ajustes UI:** iteração do commit `97c6832` — refinamentos no fluxo de auto-reatribuição quando staff entra de férias; consolidação do hard-delete para admin; agrupamento visual das folgas rotativas; ajustes UI. |
| Commit `5674c1f` | — | **Fix build Vercel — escape de aspas em JSX:** corrigido erro de build da Vercel causado por aspas não escapadas em JSX. Os caracteres `'` em texto literal dentro de componentes JSX passaram a ser escapados corretamente. Desbloqueou o deploy. |
| Commit `2984270` | — | **Associação parceiro relacional + status Smoobu real + configs restritas a admin + limpeza dev UI:** (1) **Badge de Parceiro Associado** em `/gestor/propriedades` — usa `parceiro_id` populado pelo backend (não mais extraído das observações); se não houver parceiro, mostra "All2gether". (2) **Select de Parceiro** nos formulários de criação/edição de propriedades — busca `GET /api/gestor/parceiros`. (3) **Status Smoobu real** em `/gestor/configuracoes/integracoes` — o indicador de estado da integração passou a refletir o status real do backend (não um placeholder). (4) **Configs restritas a admin** — `useUserRole()` hook no `gestor-sidebar.tsx` esconde o item "Configurações" para `role !== 'admin'`. (5) **Saudação dinâmica** — `useRoleLabel()` hook mostra "Admin" ou "Gestor" na Brand e no cabeçalho mobile. (6) **Tabs em `/gestor/ausencias`** — `<Tabs>` com separador "Ausências" + novo separador "Dias de Folga" (Card com staff ativo + Badges "Seg", "Ter", etc. dos `dias_folga`). (7) **Remoção de ferramentas de dev** — Card "Diagnóstico de ausências" e botão "Reaplicar ausência" removidos da UI. (8) **Prioridade visual de ausências no calendário** — função `estadoDia()` reordenada: ausências (vermelho) têm prioridade ABSOLUTA sobre tarefas (azul) na vista Equipa. tsc 0 erros ✓ · lint ✓. |
