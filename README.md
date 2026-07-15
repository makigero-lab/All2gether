# Autocell

**SaaS de gestão para Alojamento Local.**

O Autocell é uma aplicação dividida em duas partes:

- **`backend/`** — API REST construída em **Node.js + Express**, com base de dados **MongoDB** (via Mongoose). A API está desenhada para ser alojada no [Render](https://render.com).
- **`frontend/`** — Interface de utilizador em **Next.js 14 + TypeScript + Tailwind CSS + shadcn/ui**, com duas áreas: Painel de Administração (`/admin`) e Área do Staff (`/staff`). Desenhada para a [Vercel](https://vercel.com), comunica com a API via CORS. *(Fase atual: dados fictícios/mock.)*

> 📌 Repositório: https://github.com/makigero-lab/Autocell
> 🌿 Branch de desenvolvimento ativa: **`dev`**

---

## Estrutura do repositório

```
Autocell/
├── backend/        # API REST (Node.js + Express + MongoDB)
│   ├── package.json
│   ├── server.js
│   ├── controllers/webhookController.js
│   ├── models/ (Propriedade, Utilizador, Ausencia, Tarefa)
│   ├── routes/webhookRoutes.js
│   ├── .env.example
│   └── .gitignore
├── frontend/       # Interface (Next.js 14 + TS + Tailwind + shadcn/ui)
│   ├── package.json
│   ├── src/app/        # Rotas: /, /admin/*, /staff
│   ├── src/components/ # ui (shadcn) + admin + staff
│   └── src/lib/        # utils + mock-data
├── docs/           # Documentação técnica do projeto
│   ├── BACKEND.md
│   └── FRONTEND.md
└── README.md
```

---

## Backend

### Pré-requisitos
- Node.js **18 ou superior**
- Uma instância do **MongoDB** (local, MongoDB Atlas ou um add-on do Render)

### Instalação e execução local

```bash
cd backend
npm install
cp .env.example .env      # preenche MONGODB_URI e PORT no .env
npm run dev               # desenvolvimento (com reinício automático)
# ou
npm start                 # produção
```

A API arranca na porta definida em `PORT` (por defeito **5000**).

### Variáveis de ambiente

| Variável      | Descrição                                      | Exemplo                                   |
|---------------|------------------------------------------------|-------------------------------------------|
| `MONGODB_URI` | URI de ligação ao MongoDB                       | `mongodb://localhost:27017/autocell`      |
| `PORT`        | Porta onde a API escuta (no Render é injetada) | `5000`                                    |

### Endpoints disponíveis

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET`  | `/`  | Healthcheck. Devolve `{ "status": "API do Alojamento Local online e ligada à BD!" }` |
| `GET`  | `/api/health` | Estado da API + BD (MongoDB) + uptime. Devolve `503` se a BD estiver em baixo. |
| `POST` | `/webhooks/smoobu` | Webhook do Smoobu (nova reserva). Cria a Tarefa de limpeza aplicando filtro de ausências + folgas fixas + **Algoritmo VIP (funcionário preferencial)** + load balancing (Haversine + SLA 8h/dia). Guarda os `detalhes_reserva` (checkin, checkout, pax, nome_hospede). Responde `200` imediato e processa de forma assíncrona. Propriedades inativas são ignoradas. |
| `POST` | `/api/auth/login` | **Login** (público, com rate limiting). Body: `{ email, password }`. Devolve `{ token, utilizador }`. |
| `GET`  | `/api/auth/me` | Dados do utilizador autenticado. **Auth:** JWT. |
| `GET`  | `/api/auth/me/calendario` | Calendário pessoal (tarefas + ausências). **Auth:** JWT. |
| `GET`  | `/api/auth/me/tarefas` | Tarefas de hoje do utilizador. **Auth:** JWT. |
| `PATCH`| `/api/auth/me/tarefas/:id/concluir` | Concluir tarefa (staff). **Auth:** JWT. |
| `GET`  | `/api/auth/me/push-vapid-public-key` | Devolve a chave pública VAPID para subscrição push. **Auth:** JWT. |
| `POST` | `/api/auth/me/push-subscribe` | Guarda a subscrição push do browser no utilizador. Body: `{ subscription }`. **Auth:** JWT. |
| `POST` | `/api/auth/me/push-unsubscribe` | Remove a subscrição push do utilizador. **Auth:** JWT. |
| `GET`  | `/api/gestor/dashboard` | Estatísticas em tempo real (propriedades, equipa, tarefas hoje, carga por staff). **Auth:** JWT. |
| `GET`  | `/api/gestor/propriedades` | Lista as propriedades da empresa. **Auth:** JWT. |
| `POST` | `/api/gestor/propriedades` | Cria propriedade (com geocoding da morada). **Auth:** JWT; **Body:** `smoobu_id`, `nome`, `morada`, `tempo_limpeza_minutos?` |
| `PATCH`| `/api/gestor/propriedades/:id/estado` | Ativa/desativa propriedade (webhook ignora inativas). **Auth:** JWT. |
| `PUT` | `/api/gestor/propriedades/:id` | Atualiza propriedade (nome, smoobu_id, morada, tempo). Re-faz geocoding se morada mudar. **Auth:** JWT. |
| `GET`  | `/api/gestor/tarefas` | Lista tarefas (calendário de operações). Query: `?inicio=&fim=`. **Auth:** JWT. |
| `GET`  | `/api/gestor/calendario/dados` | Endpoint unificado para Calendário Visual Avançado. Filtros: `?inicio=&fim=&propriedadeId=&utilizadorId=&estado=`. Populate propriedade (nome+morada) + utilizador (nome). **Auth:** JWT. |
| `GET`  | `/api/gestor/tarefas/export` | Exportação CSV de tarefas. Query: `?inicio=&fim=`. **Auth:** JWT. |
| `POST` | `/api/gestor/tarefas` | Cria tarefa manualmente. **Auth:** JWT. |
| `PATCH`| `/api/gestor/tarefas/:id/atribuir` | Atribui tarefa a um funcionário. **Auth:** JWT. |
| `PATCH`| `/api/gestor/tarefas/:id/estado` | Atualiza estado da tarefa. **Auth:** JWT. |
| `POST` | `/api/gestor/tarefas/:id/atraso` | Reporta atraso (soma minutos). **Auth:** JWT. |
| `GET`  | `/api/gestor/equipa` | Lista os utilizadores da empresa (sem `password_hash`). **Auth:** JWT. |
| `POST` | `/api/gestor/equipa` | Cria membro de equipa (bcrypt hash). **Auth:** JWT; **Body:** `nome`, `email`, `password`, `role?`, `dias_folga?`, `telefone?` |
| `PUT`  | `/api/gestor/equipa/:id` | Atualiza utilizador. **Auth:** JWT. |
| `PATCH`| `/api/gestor/equipa/:id/estado` | Alterna ativo/desativado. **Auth:** JWT. |
| `DELETE`| `/api/gestor/equipa/:id` | Elimina utilizador (soft delete). **Auth:** JWT. |
| `POST` | `/api/gestor/equipa/:id/falta-subita` | Reatribuição de emergência (tarefas do dia). **Auth:** JWT. |
| `POST` | `/api/gestor/equipa/:id/baixa` | Baixa prolongada/férias (redistribui tarefas futuras). **Auth:** JWT. |
| `GET`  | `/api/gestor/ausencias` | Lista ausências (incl. pendentes para aprovação). Query: `?futuras=true`. **Auth:** JWT. |
| `POST` | `/api/gestor/ausencias` | Regista ausência (admin → estado 'aprovada'). **Auth:** JWT. |
| `DELETE`| `/api/gestor/ausencias/:id` | Elimina ausência. **Auth:** JWT. |
| `PATCH`| `/api/gestor/ausencias/:id/estado` | Aprovar/rejeitar pedido do staff. Body: `{ estado: 'aprovada'\|'rejeitada' }`. Aprovar → redistribui tarefas. **Auth:** JWT. |
| `GET`  | `/api/staff/ausencias` | Staff vê as SUAS ausências (histórico). **Auth:** JWT. |
| `POST` | `/api/staff/ausencias` | Staff cria pedido de ausência (sempre 'pendente'). Body: `{ data_inicio, data_fim, tipo, notas? }`. **Auth:** JWT. |
| `POST` | `/api/staff/falta-hoje` | Staff reporta falta de emergência para o dia atual (estado 'pendente_emergencia'). Body: `{ justificacao? }`. **Auth:** JWT. |
| `GET`  | `/api/gestor/auditoria` | Histórico de ações administrativas. Query: `?limit=`. **Auth:** JWT. |
| `GET`  | `/api/gestor/relatorios/produtividade` | Relatório de produtividade (resumo + por staff/dia/estado/propriedade). Query: `?inicio=&fim=`. **Auth:** JWT. |
| `GET`  | `/api/gestor/webhooks` | Lista logs de webhooks do Smoobu (status + payload + erro). Query: `?status=&limit=`. **Auth:** JWT. |
| `POST` | `/api/gestor/webhooks/:id/reprocessar` | Reproccessa webhook que falhou (reutiliza payload guardado, idempotente). **Auth:** JWT. |
| `POST` | `/api/gestor/smoobu/sincronizar` | Sincroniza reservas futuras do Smoobu via REST API (pull). Idempotente. Requer `SMOOBU_API_KEY`. **Auth:** JWT. |
| `GET`  | `/api/gestor/smoobu/propriedades` | Lista apartamentos do Smoobu (para dropdown no fluxo de criação). Requer `SMOOBU_API_KEY`. **Auth:** JWT. |
| `POST` | `/api/gestor/smoobu/sincronizar-propriedades` | Importa apartamentos do Smoobu em massa. Cria os novos e **atualiza sempre** a morada + capacidade_hospedes dos já existentes (com re-geocoding) quando o Smoobu as traz (Prompt 92). Requer `SMOOBU_API_KEY`. **Auth:** JWT. |
| `GET`  | `/api/gestor/setup` | Bootstrap do "Cliente Zero" (Empresa + Admin + Gestor + Staff + Propriedade de teste). Idempotente. **PÚBLICO.** |
| `POST` | `/api/gestor/propriedades/default-checklist` | Aplica o checklist padrão (6 itens) a TODAS as propriedades da empresa. Substitui o existente. **Auth:** JWT + `isGestor`. (Prompt 113) |
| `GET`  | `/api/admin/empresas` | Lista todas as empresas (cross-tenant) com gestor principal. **Auth:** JWT + `isAdmin`. |
| `POST` | `/api/admin/empresas/:id/impersonar` | Gera token JWT do gestor de uma empresa (impersonation). Se a empresa não tiver gestor ativo, o admin faz override (token com empresa_id alvo + role 'gestor'). Guarda o token de admin num cookie separado para "Voltar a Admin". **Auth:** JWT + `isAdmin`. |
| `POST` | `/api/auth/exit-impersonation` | Restaura a sessão de Super Admin após impersonação (copia o cookie `autocell_admin_token` de volta para `autocell_token`). **Auth:** implícita (cookie). (Prompt 113) |
| `GET`  | `/api/auth/me/notificacoes` | Lista notificações in-app do utilizador (query `?lidas=false` para só não-lidas). **Auth:** JWT. (Prompt 114) |
| `GET`  | `/api/auth/me/notificacoes/contagem` | Contagem de notificações não-lidas (para o badge do sino). **Auth:** JWT. (Prompt 114) |
| `PATCH`| `/api/auth/me/notificacoes/marcar-lidas` | Marca TODAS as notificações não-lidas como lidas. **Auth:** JWT. (Prompt 114) |
| `PATCH`| `/api/auth/me/notificacoes/:id/lida` | Marca UMA notificação como lida. **Auth:** JWT. (Prompt 114) |
| `GET`  | `/api/admin/empresas/:empresaId/utilizadores` | Lista todos os utilizadores (gestores + staff) de uma empresa terceira. **Auth:** JWT + `isAdmin`. |
| `POST` | `/api/admin/empresas/:empresaId/utilizadores` | Cria um gestor/staff numa empresa terceira (empresa_id vem do URL). Body: `nome`, `email`, `password`, `role?`. **Auth:** JWT + `isAdmin`. |
| `PATCH`| `/api/admin/empresas/:empresaId/utilizadores/:utilizadorId/estado` | Alterna ativo/inativo de um utilizador de uma empresa terceira. Body (opcional): `{ ativo: boolean }`. **Auth:** JWT + `isAdmin`. |
| `PATCH`| `/api/admin/empresas/:id/toggle-status` | Ativa/suspende uma empresa (`ativa: true/false`). Empresas suspensas ficam bloqueadas para o gestor/staff. **Auth:** JWT + `isAdmin`. (Prompt 116) |
| `POST` | `/api/admin/empresas/:id/hard-reset` | Hard reset **scoped à empresa** — apaga Propriedades + Tarefas + Ausências + Webhooks + Notificações dessa empresa (sem tocar noutras). Substitui o `DELETE /api/admin/hard-reset` global. **Auth:** JWT + `isAdmin`. (Prompt 116) |
| `DELETE`| `/api/admin/empresas/:id` | **Soft delete** de empresa — marca `apagada: true, ativa: false` (vai para a Reciclagem). Auditoria registada. **Auth:** JWT + `isAdmin`. (Prompt 122) |
| `PATCH`| `/api/admin/empresas/:id/restaurar` | Restaura empresa da Reciclagem (`apagada: false`). `ativa` mantém-se `false` — o admin deve reativar manualmente. **Auth:** JWT + `isAdmin`. (Prompt 122) |
| `GET`  | `/api/admin/empresas/:id/config` | Lê a configuração de uma empresa (nome, NIF, API key Smoobu). **Auth:** JWT + `isAdmin`. (Prompt 117) |
| `PUT`  | `/api/admin/empresas/:id/config` | Atualiza a configuração de uma empresa (nome, NIF, API key Smoobu). **Auth:** JWT + `isAdmin`. (Prompt 117) |
| `POST` | `/api/admin/empresas/:id/sincronizar-propriedades` | Importa apartamentos do Smoobu em massa para a empresa (re-geocoding + atualização de morada/capacidade). Requer `SMOOBU_API_KEY` na config da empresa. **Auth:** JWT + `isAdmin`. (Prompt 117) |
| `POST` | `/api/admin/empresas/:id/sincronizar-reservas` | Sincroniza reservas futuras do Smoobu para a empresa (pull REST API, idempotente). Requer `SMOOBU_API_KEY`. **Auth:** JWT + `isAdmin`. (Prompt 117) |
| `POST` | `/api/admin/empresas/:id/registrar-webhooks` | Regista os webhooks do Smoobu para a empresa. Requer `SMOOBU_API_KEY`. **Auth:** JWT + `isAdmin`. (Prompt 117) |
| `POST` | `/api/gestor/relatorios/ai-summary` | Gera um **resumo em linguagem natural** do relatório de produtividade via Gemini SDK (`@google/generative-ai`). Nunca crasha — devolve placeholder se a IA falhar. **Auth:** JWT + `isGestor`. (Prompt 123) |
| `POST` | `/api/admin/backfill-nomes-hospedes` | **Backfill de nomes de hóspedes** — percorre as tarefas com `smoobu_reserva_id` mas sem `nome_hospede` e busca o nome via REST API do Smoobu. Body opcional: `{ empresa_id }`. Requer `SMOOBU_API_KEY`. **Auth:** JWT + `isAdmin`. (Prompt 137) |
| `POST` | `/api/admin/backfill-tempos-viagem` | **Backfill de tempos de viagem** — percorre as tarefas atribuídas sem `tempo_viagem_minutos` e calcula a viagem (Haversine, máx. 60min) com base na tarefa anterior do mesmo staff no mesmo dia. Body opcional: `{ empresa_id }`. **Auth:** JWT + `isAdmin`. (Prompt 139) |

> Detalhes completos da lógica de atribuição (regras de negócio) em [`docs/BACKEND.md`](docs/BACKEND.md#32-lógica-central--atribuição-de-tarefas-webhook-smoobu).

### Deploy no Render
1. Cria um novo serviço **Web Service** apontando para a pasta `backend/`.
2. **Build Command:** `npm install`
3. **Start Command:** `npm start` (executa `node server.js`)
4. Adiciona as variáveis de ambiente `MONGODB_URI` (e opcionalmente `PORT`).
5. O Render injeta automaticamente a variável `PORT`; a aplicação respeita esse valor.

---

## Frontend

### Pré-requisitos
- Node.js **18 ou superior**

### Instalação e execução local

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

Abrir http://localhost:3000 → landing page com links para `/admin` e `/staff`.

### Rotas

| Rota | Área | Descrição |
|------|------|-----------|
| `/` | — | Landing premium (1 botão 'Entrar na Plataforma' → `/login`); autenticados são redirecionados |
| `/login` | — | **Login** (POST /api/auth/login; redirect admin→`/admin`, staff→`/staff` ou `?from=`); autenticados são redirecionados |
| `/admin` | Admin (protegido, role admin) | Dashboard com sidebar (Dashboard, Propriedades, Equipa, Calendário de Folgas) |
| `/admin/propriedades` | Admin | **Consome a API real** — tabela de propriedades (GET) + formulário de criação (POST) |
| `/admin/equipa` | Admin | **Consome a API real** — tabela de utilizadores (GET) + formulário de criação de funcionário (POST) |
| `/admin/calendario` | Admin | **Consome a API real** — calendário de folgas/férias (marcar + eliminar ausências) |
| `/staff` | Staff (protegido, role staff, mobile-first) | Cabeçalho "Bem-vindo, [Nome]" + lista de cartões de tarefas de limpeza do dia |
| `/staff/tarefas/[id]` | Staff (mobile-first) | Detalhe da Tarefa: checklist interativa + observações + botão "Concluir Tarefa" (desativado até todas as checkboxes marcadas) |

> **Proteção de rotas:** `/admin/**`, `/gestor/**` e `/staff/**` exigem token JWT válido (via `middleware.ts` + `RouteGuard`). `/` e `/login` redirecionam utilizadores autenticados para o seu painel (admin→`/admin`, gestor→`/gestor`, staff→`/staff`). Mock data ainda usado em `/staff` e dashboard admin; `/admin/propriedades` consome a API real.

### Variáveis de ambiente

| Variável | Descrição | Exemplo |
|-----------|-----------|---------|
| `NEXT_PUBLIC_API_URL` | URL base da API backend (Render). Usada na fase de integração. | `https://autocell-backend.onrender.com` |

### Deploy na Vercel

> ⚠️ Se aparecer o erro `No Output Directory named "public" found`, é porque o Vercel não detetou o projeto como Next.js. Ver **definições obrigatórias** abaixo.

**Definições obrigatórias (Project Settings):**

| Definição | Valor |
|-----------|-------|
| Root Directory | `frontend` |
| Framework Preset | **Next.js** (se estiver "Other", o build falha) |
| Build Command | `next build` *(auto)* |
| Output Directory | `.next` *(auto — não definir como `public`)* |
| Environment Variables | `NEXT_PUBLIC_API_URL` |

O repositório inclui `frontend/vercel.json` com `"framework": "nextjs"` que força a deteção correta do framework mesmo que a auto-deteção falhe. **Este ficheiro só é lido se o Root Directory = `frontend`.**

**Passos para reconfigurar um projeto já criado:**
1. Vercel → Project → Settings → General → **Root Directory** = `frontend` → Save.
2. Settings → Build & Development Settings → **Framework Preset = Next.js**.
3. Settings → Environment Variables → adicionar `NEXT_PUBLIC_API_URL`.
4. Deployments → Redeploy.

---

## Documentação

- [📚 Documentação técnica do Backend](docs/BACKEND.md)
- [🎨 Documentação técnica do Frontend](docs/FRONTEND.md)

---

## Notas de desenvolvimento
- Todo o desenvolvimento decorre na branch **`dev`**.
- Sempre que o código é alterado, a documentação (este `README.md` e a pasta `docs/`) é atualizada em conformidade.
- Histórico de evolução técnica disponível no worklog interno do projeto.

---

## Integração Contínua (CI)

O repositório inclui um workflow de GitHub Actions em [`.github/workflows/ci.yml`](.github/workflows/ci.yml) que corre em todos os `push` e `pull_request` nas branches `main` e `dev`:

| Job | Passos | Diretoria |
|-----|--------|-----------|
| **Frontend** | `npm ci` → `npm run lint` → `npx tsc --noEmit` → `npm run build` | `frontend/` |
| **Backend** | `npm ci` → `npm test` (Jest + Supertest) | `backend/` |

Ambos os jobs correm em `ubuntu-latest` com Node.js 18. O estado da pipeline é visível no separador **Actions** do GitHub.

### Testes do Backend
- Framework: **Jest** + **Supertest**
- Localização: `backend/tests/`
- Para correr localmente: `cd backend && npm test`
- O `server.js` exporta a instância `app` e isola o `app.listen` em `if (require.main === module)`, permitindo testar as rotas sem iniciar o servidor HTTP nem ligar ao MongoDB.
