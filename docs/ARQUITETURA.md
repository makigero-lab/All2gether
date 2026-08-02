# Arquitetura All2gether — v1.0

> **Estado:** Documento de arquitetura atualizado para refletir o sistema em produção.
> **Data:** Rebranding consolidado (regresso ao domínio Alojamento Local e Airbnb).
> **Linguagem:** pt-PT

---

## 1. Visão Geral

O **All2gether** é um SaaS B2B multi-tenant para **gestão de tarefas automáticas de
Alojamento Local e Airbnb**. Cada empresa (gestora de propriedades) é um tenant isolado,
com a sua equipa de staff, as suas propriedades (apartamentos/unidades) e as suas tarefas
de limpeza/manutenção.

O sistema atribui automaticamente tarefas ao staff disponível através de um **load balancer**
que tem em conta ausências, folgas, proximidade geográfica (Haversine), carga de trabalho
acumulada e preferência por propriedade (VIP).

### Stack
- **Backend:** Node.js + Express + MongoDB (Mongoose) — deploy no Render
- **Frontend:** Next.js 14 + TypeScript + Tailwind + shadcn/ui — deploy na Vercel
- **Calendário:** FullCalendar v6 (react + daygrid + timegrid + interaction)
- **Notificações:** Web Push API (VAPID) + notificações in-app
- **IA:** Google Gemini SDK (`@google/generative-ai`) para resumos de relatórios

---

## 2. Princípios Arquiteturais

| Padrão | Justificação |
|--------|-------------|
| Multi-tenant via `empresa_id` | Cada empresa = tenant isolado |
| `{ timestamps: true }` em todos os schemas | `createdAt`/`updatedAt` automáticos |
| Soft delete (`eliminado_em`, `apagada`) | Histórico preservado para auditoria |
| Índices explícitos em campos de query | Calendário e tarefas são hot paths |
| RBAC via `requireRole(...roles)` | Composável, testável |
| JWT em cookie httpOnly | SameSite=Strict + Secure |
| Cron jobs com `node-cron` | Timezone `Europe/Lisbon` blindado |
| Snapshots imutáveis (`checklist_dinamica`) | Checklists aplicadas ficam imutáveis no tempo |
| Modelo de arquivo (`TarefaArquivo`) | Tarefas antigas saem da coleção quente |

---

## 3. Hierarquia de Roles

```
admin (Super Admin da PLATAFORMA — cross-tenant)
  • Gere todas as empresas (criar, suspender, apagar, restaurar)
  • Impersonation de gestores para suporte
  • Não tem acesso a dados operacionais por design

gestor (Gestor de Operações — por tenant)
  • Acesso TOTAL à empresa (menos super-admin)
  • Vê todas as propriedades, equipa, tarefas, calendário
  • Aprova ausências, gere equipa, relatórios, webhooks
  • Define checklists por propriedade
  • Atribui/reatribui tarefas manualmente

staff (Staff de Limpeza/Manutenção — por tenant)
  • Vê SÓ as suas tarefas (hoje, calendário)
  • Conclui tarefas (checklist interativa)
  • Pede ausências/férias (gestor aprova)
  • Reporta falta súbita de emergência
  • NÃO vê gestão de equipa nem relatórios
```

### Matriz de Permissões

| Recurso | admin | gestor | staff |
|---------|:-----:|:------:|:-----:|
| Empresas (cross-tenant) | ✅ | ❌ | ❌ |
| Equipa (criar/editar/desativar) | ✅ | ✅ | ❌ |
| Propriedades (CRUD) | ✅ | ✅ | ❌ |
| Tarefas (criar/atribuir/estado) | ✅ | ✅ | ❌ |
| Tarefas (concluir as suas) | — | ✅ | ✅ |
| Ausências (aprovar) | ✅ | ✅ | pede |
| Calendário (todas as tarefas) | ✅ | ✅ | só as suas |
| Relatórios / AI summary | ✅ | ✅ | ❌ |
| Auditoria | ✅ | ✅ | ❌ |
| Impersonation | ✅ | ❌ | ❌ |

### Middleware (código real)

```js
const isGestor = requireRole('admin', 'gestor');   // painel /gestor/*
const isAdmin  = requireRole('admin');              // painel /admin/* (estrito)
const isStaff  = requireRole('staff', 'gestor');
```

---

## 4. Modelos de Dados (atuais)

### 4.1 Empresa (Gestora de Alojamento Local)

```js
empresaSchema = {
  nome:        { type: String, required: true, index: true },
  nif:         { type: String, trim: true },
  morada:      { type: String, trim: true, default: '' },
  telefone:    { type: String, trim: true, default: '' },
  email:       { type: String, lowercase: true, trim: true, default: '' },
  logo_url:    { type: String, default: '' },
  // DCE-B: plano_ativo (SaaS informativo) removido — gestão de Planos passou para a Nave-Mãe.
  ativa:       { type: Boolean, default: true, index: true },
  apagada:     { type: Boolean, default: false, index: true },
}
```

### 4.2 Utilizador

```js
utilizadorSchema = {
  nome, email, telefone, password_hash, empresa_id,
  role: { type: String, enum: ['admin', 'gestor', 'staff'], default: 'staff' },
  ativo, eliminado_em, pushSubscription, dias_folga,
}
```

### 4.3 Propriedade (Alojamento)

```js
propriedadeSchema = {
  empresa_id, nome, morada,
  coordenadas: { lat, lng },  // geocoding Nominatim
  tempo_limpeza_minutos: { type: Number, default: 45 },
  ativo: { type: Boolean, default: true },
  checklist: [String],
  modelo_checklist_id,  // referência a ModeloChecklist (Prompt 133-135)
  capacidade_hospedes: { type: Number, default: null },  // Prompt 84
  funcionario_preferencial_id: { type: ObjectId, ref: 'Utilizador', default: null },  // Prompt 92 (VIP)
}
```

### 4.4 Tarefa (Limpeza/Manutenção)

```js
tarefaSchema = {
  empresa_id, propriedade_id, utilizador_id (nullable),
  data: Date,  // normalizada meia-noite UTC
  tempo_limpeza_minutos: Number,
  tipo: { enum: ['limpeza', 'check_in', 'check_out', 'manutencao', 'outro'] },
  estado: { enum: ['por_atribuir', 'nao_atribuida', 'atribuida', 'em_curso', 'concluida', 'cancelada'] },
  prioridade: { enum: ['normal', 'alta'] },
  checklist_dinamica: [{ label, concluido }],  // snapshot imutável (Prompt 133)
  detalhes_reserva: { checkin, checkout, pax, nome_hospede },
  observacoes, criada_por, concluida_em, atraso_minutos,
}
```

### 4.5 Outros modelos
- **`Ausencia`** — indisponibilidades do staff (férias, doença, formação). Estados: `pendente`, `aprovada`, `rejeitada`, `cancelada`.
- **`ModeloChecklist`** — templates de checklist reutilizáveis por propriedade (Prompt 133-135).
- **`Notificacao`** — notificações in-app (tipos: `tarefa_atribuida`, `tarefa_reatribuida`, `tarefa_cancelada`, `aviso`, `sistema`).
- **`WebhookLog`** — registo de payloads de webhooks para auditoria (Smoobu removido; modelo mantido para futuras integrações).
- **`TarefaArquivo`** — cópia de tarefas arquivadas (>3 meses).
- **`Auditoria`** — registo de ações administrativas.

---

## 5. Load Balancer de Atribuição

Ficheiro: `backend/utils/loadBalancer.js`

**Pipeline `determinarUtilizadorAtribuido(empresaId, range, coordenadas, tempoNovaTarefa, propriedadeId)`:**

1. **Filtro de ausências aprovadas** — staff com ausência nesse dia é excluído.
2. **Filtro de folgas fixas** (`dias_folga`) — staff cujo dia da semana está de folga é excluído.
3. **Algoritmo VIP** — se a propriedade tem `funcionario_preferencial_id` e esse staff está disponível dentro do SLA, atribui obrigatoriamente.
4. **Haversine + menor carga** — entre os staff disponíveis, escolhe o mais próximo com menor `carga_total` (tempo de limpeza acumulado do dia + tempo de viagem estimado).
5. **SLA cap** — `CAPACIDADE_MAXIMA_MINUTOS = 480` (8h/dia). Se TODOS os staff excedem o SLA, a tarefa fica `estado: 'nao_atribuida'` (Prompt 138) — distinto de `por_atribuir`.

**Cálculos auxiliares:**
- `calcularCargaLimpezaDia` — aggregate de `tempo_limpeza_minutos` do staff nesse dia.
- `calcularTempoViagem` (em `utils/scheduler.js`) — Haversine a 30 km/h urbano, cap de 60 min, fallback 30 min se coordenadas inválidas.
- `distanciaHaversine` (em `utils/distancia.js`) — warning não-bloqueante se >15km entre tarefas do mesmo dia.

---

## 6. Cron Jobs

| Job | Ficheiro | Schedule | Função |
|-----|----------|----------|--------|
| **Daily Briefing** | `jobs/dailyBriefing.js` | `0 8 * * *` (08h00) | Push a cada staff com tarefas de **hoje**. |
| **Cão de Guarda** | `jobs/caoGuarda.js` | `0 18 * * *` (18h00) | **Fase A (Fail-Safe):** auto-atribui órfãs de **amanhã** via load balancer. **Fase B:** push `⚠️ Tarefa Incompleta` por cada limpeza de **hoje** não concluída. |
| **Agenda de Amanhã** | `jobs/agendaAmanha.js` | `0 19 * * *` (19h00) | Push a cada staff com trabalho amanhã. |
| **Arquivista** | `jobs/arquivista.js` | dia 1 de cada trimestre | Move tarefas concluídas/canceladas com >3 meses para `TarefaArquivo`. |

Timezone: `Europe/Lisbon` (nativo node-cron, exceto Daily Briefing que usa `TZ` do servidor).

---

## 7. Notificações

- **Push (Web Push API / VAPID):** `utils/push.js` configura as chaves VAPID; `utils/notificar.js` `notificarUtilizador()` envia push + cria registo in-app (fire-and-forget).
- **In-app:** modelo `Notificacao`; endpoints em `/api/auth/me/notificacoes` (listar, contagem, marcar-lidas).
- **Frontend:** `components/notification-bell.tsx` (sino com badge, dropdown, polling 30s) + páginas full-page.

---

## 8. Segurança e Auditoria

- **JWT em cookie httpOnly** — `all2gether_token` (sessão) + `all2gether_admin_token` (backup de impersonação). SameSite=Strict + Secure em produção.
- **Rate limiting** — login 5/15min, global 100/15min (desativado em `NODE_ENV=test`).
- **CORS trancado** a `FRONTEND_URL`.
- **Auditoria** — `utils/auditoria.js` regista ações administrativas (toggle-status, hard-reset, soft-delete/restaurar, criar/toggle utilizadores, impersonação).
- **Soft delete** — `Utilizador.eliminado_em`, `Empresa.apagada` (Reciclagem restaurável), `Ausencia.estado='cancelada'`.
- **Hard reset scoped** — `POST /api/admin/empresas/:id/hard-reset` apaga dados apenas da empresa (não toca nas outras).

---

## 9. Impersonation (admin → gestor)

- `POST /api/admin/empresas/:id/impersonar` — gera JWT com `id` do admin, `role: 'gestor'`, `empresa_id` alvo. Override se a empresa não tiver gestor ativo.
- Cookie de backup `all2gether_admin_token` guarda o token de admin original.
- `POST /api/auth/exit-impersonation` — restaura o token de admin a partir do backup.
- Frontend: banner vermelho "Voltar a Admin" (`components/gestor/impersonation-banner.tsx`).

---

## 10. Integração de IA (Gemini)

- `POST /api/gestor/relatorios/ai-summary` — gera resumo em linguagem natural do relatório de produtividade via `@google/generative-ai`.
- **Never-crash:** try/catch abrangente → se falhar (quota, rede, JSON inválido), devolve placeholder `"Resumo temporariamente indisponível."`.
- Exportável como PDF via `window.print()`.

---

## 11. PWA e Resiliência

- **next-pwa** com `skipWaiting` + `clientsClaim` + runtime caching `NetworkFirst` em chunks.
- Handler `ChunkLoadError` com guard anti-loop.
- Service Worker não interceta `/api/`.
- Timezone blindado: helpers `parsearDataSegura` + `extrairHoraISO` (sem `new Date()` direto em strings locais).

---

## 12. Convenções do Projeto

- **Branch ativa:** `dev`
- **Linguagem:** pt-PT (código, comentários, documentação, commits)
- **Commits:** `feat|fix|chore(escopo): descrição (Prompt N)`
- **Sempre que o código é alterado, atualizar:** `README.md`, `docs/BACKEND.md`, `docs/FRONTEND.md` e `WORKLOG.md`.
- **CI:** GitHub Actions — frontend `lint + tsc + build`, backend `jest` (branches `main`/`dev`).
- **Testes:** Jest + Supertest + mongodb-memory-server.
