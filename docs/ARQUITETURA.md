# Arquitetura FisioCell — v0.1 (F0)

> **Estado:** Proposta inicial aprovada pelo utilizador.
> **Data:** F0 (rename Autocell→FisioCell + remoção Smoobu)
> **Linguagem:** pt-pt

---

## 1. Visão Geral

O **FisioCell** é um SaaS B2B multi-tenant para gestão de Clínicas de Fisioterapia.
Construído sobre a base do projeto "Autocell" (SaaS de Alojamento Local), reutiliza
a infraestrutura de autenticação, RBAC, cron jobs, calendário (FullCalendar) e
padrões arquiteturais (multi-tenant via `empresa_id`, soft delete, snapshots
imutáveis, auditoria).

### Stack
- **Backend:** Node.js + Express + MongoDB (Mongoose) — deploy no Render
- **Frontend:** Next.js 14 + TypeScript + Tailwind + shadcn/ui — deploy na Vercel
- **Calendário:** FullCalendar v6 (react + daygrid + timegrid + interaction)

---

## 2. Princípios Herdados do Código-Base

| Padrão | Justificação |
|--------|-------------|
| Multi-tenant via `empresa_id` | Cada Clínica = tenant isolado |
| `{ timestamps: true }` em todos os schemas | `createdAt`/`updatedAt` automáticos |
| Soft delete (`eliminado_em`, `apagada`) | Histórico clínico é obrigatório por lei (RGPD) |
| Índices explícitos em campos de query | Calendário e marcações são hot paths |
| RBAC via `requireRole(...roles)` | Composável, testável |
| JWT em cookie httpOnly | SameSite=Strict + Secure |
| Cron jobs com `node-cron` | Timezone `Europe/Lisbon` blindado |
| Snapshots imutáveis (checklist_dinamica) | Notas clínicas têm de ser imutáveis no tempo |
| Modelo de arquivo (`TarefaArquivo`) | Sessões antigas saem da coleção quente |

---

## 3. Hierarquia de Roles

```
admin (Super Admin da PLATAFORMA — cross-tenant)
  • Gere todas as clínicas (criar, suspender, apagar)
  • Impersonation para suporte
  • NÃO tem acesso a dados clínicos (RGPD — princípio do minimizar)

diretor_clinico (Diretor Clínico — por tenant)
  • Acesso TOTAL à clínica (menos super-admin)
  • Vê todos os pacientes, fisioterapeutas, consultas
  • Aprova ausências, gere equipa, relatórios clínicos
  • Define horários de trabalho dos fisioterapeutas
  • Pode também atender pacientes (é clínico)

fisioterapeuta (Fisioterapeuta — por tenant)
  • Vê SÓ os seus pacientes e as suas consultas
  • Marca consultas na sua agenda
  • Regista notas clínicas (SOAP), evolução
  • Pede férias/ausências (diretor aprova)
  • NÃO vê faturação nem gestão de equipa

rececionista (Rececionista — por tenant)
  • Gere marcações (criar/mover/cancelar) de TODOS
  • Gere dados administrativos do paciente (contactos)
  • Vê agenda global de todas as salas+fisioterapeutas
  • NÃO vê notas clínicas / SOAP (RGPD — need-to-know)
  • Regista presença/falta do paciente
```

### Matriz de Permissões

| Recurso | admin | diretor_clinico | fisioterapeuta | rececionista |
|---------|:-----:|:---------------:|:--------------:|:------------:|
| Clínicas (cross-tenant) | ✅ | ❌ | ❌ | ❌ |
| Equipa (criar/editar/desativar) | ✅ | ✅ | ❌ | ❌ |
| Horários fisioterapeutas | ✅ | ✅ | vê os seus | ❌ |
| Pacientes (dados admin) | ✅ | ✅ | vê os seus | ✅ |
| Pacientes (ficha clínica/SOAP) | ❌ | ✅ | ✅ (seus) | ❌ |
| Consultas (criar/editar) | ✅ | ✅ (todas) | ✅ (suas) | ✅ |
| Consultas (notas clínicas) | ❌ | ✅ | ✅ (suas) | ❌ |
| Ausências (aprovar) | ✅ | ✅ | pede | ❌ |
| Relatórios clínicos | ❌ | ✅ | seus | ❌ |
| Auditoria | ✅ | ✅ | ❌ | ❌ |

### Middleware (adaptado)

```js
const isDiretorClinico = requireRole('admin', 'diretor_clinico');
const isClinico        = requireRole('admin', 'diretor_clinico', 'fisioterapeuta');
const isRececionista   = requireRole('admin', 'diretor_clinico', 'rececionista');
const isAdmin          = requireRole('admin');
```

---

## 4. Mapa de Migração de Domínio

| Entidade atual (AL) | Nova entidade (Fisio) | Ação | Fase |
|---------------------|----------------------|------|------|
| `Empresa` | `Empresa` (= Clínica) | Adaptar — novos campos: `morada`, `telefone`, `email`, `nif` | F1 |
| `Propriedade` (alojamento) | `Sala` (espaço físico) | Adaptar — `smoobu_id` já removido em F0 | F3 |
| `Utilizador` (admin/gestor/staff) | `Utilizador` (admin/diretor/fisio/rececionista) | Adaptar — novos roles + perfil profissional | F1 |
| `Tarefa` (limpeza) | `Consulta` (sessão) | Substituir | F4 |
| `Ausencia` | `Ausencia` / `Indisponibilidade` | Manter — mesmo schema (+`tipo: 'formacao'`) | — |
| `ModeloChecklist` | `ModeloProtocolo` | Adaptar | F5 |
| `TarefaArquivo` | `ConsultaArquivo` | Manter conceito | F4 |
| `Notificacao` | `Notificacao` | Manter (novos tipos) | — |
| `Auditoria` | `Auditoria` | Manter | — |
| `WebhookLog` | `WebhookLog` | Manter (futuras integrações) | — |
| — (novo) | `Paciente` | Criar | F2 |
| — (novo) | `HorarioFisioterapeuta` | Criar | F3 |
| — (novo) | `Documento` | Criar | F9 |
| `smoobuController` | ❌ removido em F0 | — | ✅ |
| `webhookController` | ❌ removido em F0 (load balancer extraído para `utils/loadBalancer.js`) | — | ✅ |

---

## 5. Modelos Propostos (v0.1)

### 5.1 Empresa (Clínica) — adaptar em F1

```js
empresaSchema = {
  nome:        { type: String, required: true, index: true },
  nif:         { type: String, trim: true, index: true },
  morada:      { type: String, trim: true },          // ✅ adicionado em F0
  telefone:    { type: String, trim: true, default: '' },  // ✅ adicionado em F0
  email:       { type: String, lowercase: true, trim: true, default: '' },  // ✅ F0
  logo_url:    { type: String, default: '' },
  config: {
    horario_padrao: { type: [{ dia_semana: Number, abertura: String, fecho: String }], default: [] },
    duracao_consulta_padrao: { type: Number, default: 45, min: 15 },
    tolerancia_atraso_min:   { type: Number, default: 10 },
    fuso_horario:            { type: String, default: 'Europe/Lisbon' },
  },
  plano_ativo: { type: Boolean, default: true },
  ativa:       { type: Boolean, default: true, index: true },
  apagada:     { type: Boolean, default: false, index: true },
}
```

### 5.2 Utilizador — adaptar em F1

```js
utilizadorSchema = {
  nome, email, telefone, password_hash, empresa_id,
  role: {
    type: String,
    enum: ['admin', 'diretor_clinico', 'fisioterapeuta', 'rececionista'],
    default: 'rececionista',
  },
  ativo, eliminado_em, pushSubscription, dias_folga,
  // NOVO: Perfil profissional (fisio/diretor)
  perfil_profissional: {
    cedula:               { type: String, default: '' },   // Ordem dos Fisioterapeutas
    especialidades:       { type: [String], default: [] },
    biografia:            { type: String, default: '' },
    cor_calendario:       { type: String, default: '#3b82f6' },
    ativo_clinico:        { type: Boolean, default: true },
  },
}
```

### 5.3 Paciente — NOVO (F2)

```js
pacienteSchema = {
  empresa_id,  // scoping multi-tenant
  // Dados demográficos
  nome, data_nascimento, genero, num_utente, nif,
  // Contactos
  telefone, email, morada,
  // Dados clínicos (acesso restrito)
  contacto_emergencia: { nome, telefone, relacao },
  historico_medico, alergias,
  // Consentimentos (RGPD)
  consentimento_dados: { concedido, data, versao_termos },
  // Estado
  ativo, eliminado_em, observacoes, origem,
}
```

### 5.4 Consulta — substitui Tarefa (F4)

```js
consultaSchema = {
  empresa_id, sala_id, fisioterapeuta_id, paciente_id,
  data_hora_inicio, data_hora_fim, duracao_minutos,
  tipo: { enum: ['primeira_consulta', 'sessao', 'reavaliacao', 'alta', 'grupo'] },
  estado: { enum: ['marcada', 'confirmada', 'em_curso', 'concluida', 'cancelada', 'faltou', 'nao_compareceu'] },
  presenca: { enum: ['pendente', 'presente', 'ausente', 'atrasado'] },
  // Nota clínica SOAP (snapshot imutável após conclusão)
  nota_clinica: { subjetivo, objetivo, avaliacao, plano, tratamento_efetuado, protocolo_aplicado },
  // Auditoria
  criada_por, concluida_em, cancelada_em, cancelada_por,
  // Lembretes
  lembrete_24h_enviado, lembrete_2h_enviado,
  observacoes,
}
```

### 5.5 Sala — de Propriedade (F3)

```js
salaSchema = {
  empresa_id, nome, descricao, capacidade, equipamentos, ativo, observacoes,
}
```

### 5.6 HorarioFisioterapeuta — NOVO (F3)

```js
horarioFisioterapeutaSchema = {
  empresa_id, fisioterapeuta_id,
  tipo: { enum: ['recorrente', 'excecao'] },
  dia_semana: Number,  // 0-6 (recorrente)
  hora_inicio, hora_fim,
  data: Date,          // (excecao)
  disponivel: Boolean,
  ativo,
}
```

### 5.7 Documento — NOVO (F9)

Anexos a Pacientes/Consultas: receitas, relatórios, termos de consentimento e
**fotografias de documentos**. Storage em S3/Cloudinary.

```js
documentoSchema = {
  empresa_id,
  paciente_id,         // obrigatório
  consulta_id,         // opcional (se anexado a uma sessão específica)
  uploaded_by,         // utilizador que carregou
  tipo: { enum: ['receita', 'relatorio', 'termo_consentimento', 'foto', 'exame', 'outro'] },
  nome_original,       // nome do ficheiro carregado
  url_storage,         // URL no S3/Cloudinary
  content_type,        // MIME type
  tamanho_bytes,
  // Metadados clínicos (opcional)
  descricao,
  // RGPD
  consentimento_obtido: Boolean,
  data_consentimento: Date,
  // Soft delete
  eliminado_em: Date,
}
```

---

## 6. Cron Jobs — Adaptação

| Job atual | Novo job | Schedule |
|-----------|----------|----------|
| `dailyBriefing` | `briefingDiarioFisio` | 08:00 — push a cada fisio |
| `agendaAmanha` | `lembreteConsultasAmanha` | 19:00 — SMS/push ao paciente |
| — (novo) | `lembrete2hConsulta` | a cada 15min — SMS 2h antes |
| `caoGuarda` | `caoGuardaConsultas` | 02:00 — verifica consultas órfãs |
| `arquivista` | `arquivistaConsultas` | semanal — move > 6 meses para arquivo |

---

## 7. Decisões de Design

1. **Fisioterapeuta = Utilizador** (não modelo separado) — coerência com código-base
2. **Paciente = modelo separado** — não faz login, gerido pela clínica
3. **Nota clínica embutida na Consulta** — snapshots imutáveis (padrão checklist_dinamica)
4. **Sala como entidade de 1º nível** — permite detetar sobreocupação
5. **Horário do fisio = modelo dedicado** — horários complexos (manhãs seg/qua/sex)
6. **admin não vê dados clínicos** — RGPD princípio do minimizar
7. **Soft delete em tudo** — obrigações de retenção (10-20 anos)
8. **3 camadas de disponibilidade** — folga / horário / exceção / ausência

---

## 8. Roadmap de Migração

| Fase | Âmbito | Estado |
|------|--------|--------|
| **F0** | Rename Autocell→FisioCell + remoção Smoobu + docs | ✅ Concluído |
| **F1** | Adaptar Empresa + Utilizador (novos roles + perfil profissional) + requireRole | Pendente |
| **F2** | Criar Paciente + CRUD + permissões | Pendente |
| **F3** | Sala (de Propriedade) + HorarioFisioterapeuta + motor de disponibilidade | Pendente |
| **F4** | Consulta (de Tarefa) + CRUD de marcação + validação de conflitos | Pendente |
| **F5** | Nota clínica SOAP + ModeloProtocolo (de ModeloChecklist) | Pendente |
| **F6** | Adaptar frontend: calendário FullCalendar mostra Consultas | Pendente |
| **F7** | Cron jobs novos (lembrete paciente, briefing fisio) | Pendente |
| **F8** | Limpeza: remover Tarefa, TarefaArquivo, Propriedade, ModeloChecklist antigos | Pendente |
| **F9** | Documentos (anexos + fotografias) — storage S3/Cloudinary | Pendente |

---

## 9. Questões Respondidas pelo Utilador

1. **Faturação:** Não (futuro)
2. **Portal do paciente:** Não (futuro)
3. **Múltiplas clínicas por fisio:** Não (uma clínica por agora)
4. **Documentos + fotografias:** Sim → modelo `Documento` (F9)
5. **Sessões em grupo:** Não
