# Operações (backup e ping) — All2gether

Custo zero: GitHub Actions (backup) + um cron externo grátis (ping). Sem staging nem plano pago.

## 1. Backup diário do MongoDB

Workflow: `.github/workflows/backup.yml` (todos os dias às 03:17 UTC e manual em *Actions > Backup MongoDB > Run workflow*). Faz `mongodump --archive --gzip`, cifra com AES-256 (`gpg --symmetric`) dentro do runner e guarda só o ficheiro cifrado como artifact durante 14 dias. Falha de forma visível (job vermelho) se o dump falhar ou vier vazio.

### Configurar (uma vez)
1. GitHub > repositório > *Settings > Secrets and variables > Actions > New repository secret*:
   - `MONGODB_URI`: URI do Atlas. Recomendado: um utilizador de BD só com leitura (role `read` na base) criado só para o backup.
   - `BACKUP_PASSPHRASE`: frase longa e aleatória. **Guarda-a também fora do GitHub** (gestor de palavras-passe); sem ela o backup não se restaura.
2. Atlas > *Network Access*: os runners do GitHub não têm IP fixo, por isso o Atlas tem de aceitar a ligação deles (`0.0.0.0/0` é a única opção grátis; mitiga-se com o utilizador só de leitura e palavra-passe forte). Sem isto o workflow falha na ligação.
3. O workflow **só aparece em *Actions* e só corre depois de estar na branch `main`** (limitação do GitHub): o agendamento e o disparo manual ficam disponíveis após o merge.
4. Corre-o uma vez à mão e confirma que o artifact `mongodb-backup` aparece.

### Restaurar (passo a passo)
Pré-requisitos locais: `gpg` e as [MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools).
1. GitHub > *Actions > Backup MongoDB >* execução pretendida > descarrega o artifact `mongodb-backup` e descompacta o zip (fica `all2gether-<data>.archive.gz.gpg`).
2. Decifra (pede a passphrase; ou usa `--passphrase-file`):
   `gpg --output dump.archive.gz --decrypt all2gether-<data>.archive.gz.gpg`
3. Restaura para um cluster/base de TESTE primeiro:
   `mongorestore --uri "<URI_DE_DESTINO>" --archive=dump.archive.gz --gzip`
   (acrescenta `--drop` só se quiseres substituir coleções existentes; usa `--nsInclude "base.colecao"` para restaurar apenas uma coleção.)
4. Verifica contagens/dados e só depois, se necessário, restaura em produção. Apaga o `dump.archive.gz` em claro quando terminares (contém dados pessoais).

### Teste de restauro (semanal, automático)
Um backup que nunca foi restaurado não está provado. O workflow `.github/workflows/backup-restauro-teste.yml` (*Actions > Teste de restauro do backup*; domingo às 04:17 UTC, uma hora depois do backup, e manual) descarrega o artifact mais recente do backup, decifra-o com `BACKUP_PASSPHRASE`, restaura-o com `mongorestore` num MongoDB temporário que corre no próprio runner (service container; nunca toca no Atlas) e confirma que `tarefas`, `utilizadors`, `propriedades` e `empresas` existem com mais de 0 documentos. O resumo do job mostra só nomes de coleções e contagens, nunca dados. Se algo falhar o job fica vermelho (o GitHub avisa por email). Os ficheiros decifrados são apagados no fim, mesmo em caso de falha. Não precisa de secrets novos (usa `BACKUP_PASSPHRASE`) e só aparece em *Actions* depois de estar na `main`. Se um backup falhar ou estiver expirado (14 dias), corre primeiro o workflow de backup.

## 2. Ping para o Render não adormecer

O Render grátis adormece após inatividade. Usa um serviço externo, **não** o GitHub Actions (gastaria minutos).
1. Cria conta grátis em [cron-job.org](https://cron-job.org).
2. Novo cron job: URL `https://all2gether.onrender.com/api/health`, método GET, de 10 em 10 minutos.
3. Opcional: ativa a notificação por email em caso de falha.

## 3. Reconciliação do Smoobu (opcional)
Rede de segurança dos webhooks, desligada por defeito. Para ativar numa empresa: *Configurações > Integrações > Rotinas* (sincronização automática + frequência em horas, mínimo 1). Ver `docs/BACKEND.md`.

## 4. Limpar equipas fantasma (uma vez)
Tarefas sem responsável (`utilizador_id` null) com `equipa_atribuida` preenchida, nos estados `por_atribuir`, `nao_atribuida` e `cancelada`. O código já as ignora; o script limpa os dados (`equipa_atribuida: []`, `pessoas_em_falta: 0`; mais nenhum campo). Idempotente.

```
cd backend
# 1) só conta (não altera; mostra números por estado, sem dados pessoais)
MONGODB_URI="<uri de produção>" node scripts/limpar-equipas-fantasma.js
# 2) depois de confirmar os números (esperado ~8 por_atribuir e ~455 cancelada)
MONGODB_URI="<uri de produção>" node scripts/limpar-equipas-fantasma.js --aplicar
```
Fazer um backup antes (secção 1). Consulta só de leitura equivalente (mongosh):
`db.tarefas.countDocuments({ utilizador_id: null, "equipa_atribuida.0": { $exists: true }, estado: { $in: ["por_atribuir","nao_atribuida","cancelada"] } })`

## 5. Reagendar limpezas fora do horário (uma vez, depois do deploy)
Corrige as limpezas futuras atribuídas com hora fora do horário (antes das 09:00, incluindo a meia-noite, ou a acabar depois das 18:00). Só toca em tarefas de hoje em diante no estado `atribuida`; nunca em `em_curso`, `concluida` ou `cancelada`. Recalcula pela ordem atual, respeitando 09:00-18:00, almoço (início entre 12:00 e 14:00) e viagens; o que não couber passa ao motor para outra pessoa; o que ninguém puder fica por atribuir com o motivo real. É idempotente.
```
cd backend
# 1) só mostra números e a lista (tarefa, dia, pessoa, propriedade, antes, depois; sem dados de hóspedes)
MONGODB_URI="<uri de produção>" node scripts/reagendar-horarios.js
# 2) aplicar (sem notificações)
MONGODB_URI="<uri de produção>" node scripts/reagendar-horarios.js --aplicar
# 3) opcional: avisar só quem mudou (um aviso por pessoa; avisa os gestores se sobrar algo por atribuir)
MONGODB_URI="<uri de produção>" node scripts/reagendar-horarios.js --aplicar --avisar
```
`--empresa <id>` limita a uma empresa. Sem `--aplicar`, as passagens para outra pessoa são uma estimativa (o motor vê a base como está). Fazer um backup antes (secção 1) e correr primeiro sem `--aplicar`.

## 6. Verificação em produção dos índices novos (só leitura)
Os índices novos são parciais e só abrangem documentos que tenham o campo novo, por isso não falham com dados antigos. Para confirmar depois do arranque:
`db.reservamanuals.getIndexes()` deve listar `parceiro_id_1_chave_idempotencia_1` (unique, partialFilterExpression `chave_idempotencia: {$type: "string"}`). A coleção `lockempresas` é criada na primeira importação de Excel (lock com expiração de 2 min).

## 7. Fim de contrato: exportar e apagar uma empresa (RGPD)

Só o Super Admin (*Configurações > Empresas: fim de contrato (RGPD)*; API em `/api/admin/empresas/:id/...`).

1. **Exportar empresa** (`GET /exportar`): descarrega um JSON com todas as coleções filtradas por `empresa_id` (e as notificações/auditoria antigas ligadas pelos utilizadores), sem `password_hash`, `pushSubscription` nem chaves/tokens (a chave do Smoobu é removida). É a devolução dos dados (art. 28.º, n.º 3, al. g). Vai em streaming: se o pedido pela Vercel expirar, pede-se diretamente ao backend com o token do Super Admin.
2. **Agendar eliminação** (`POST /agendar-eliminacao`, corpo `{ "confirmar": "<nome exato>", "dias": 30 }`): `dias` por omissão 30 (variável `ELIMINACAO_EMPRESA_DIAS`), mínimo 7, máximo 365. A empresa fica **desativada** já (ninguém entra, nem com sessões antigas) e `eliminacao_agendada_para` mostra a data. Não se reativa enquanto houver agendamento.
3. **Cancelar eliminação** (`POST /cancelar-eliminacao`): repõe o estado `ativa` anterior.
4. **Apagamento**: o job `jobs/eliminacaoEmpresas.js` corre todos os dias às 04:10 (Europe/Lisbon) e só apaga empresas cuja data já passou. Remove os documentos de todas as coleções com `empresa_id` (descobertas pelos esquemas: um teste falha se aparecer uma coleção nova sem cobertura) e os registos ligados só por `utilizador_id`; apaga a empresa no fim e repete a varredura para apanhar o que um job ou webhook tenha criado a meio. Mantém um único registo na auditoria da plataforma (`empresa_apagada`, `empresa_id` nulo, só nome da empresa e data). Se a empresa contiver uma conta de Super Admin (empresa-sistema) nunca é apagada.
5. **Concorrência**: o job usa o lock `eliminar-empresa:<id>` (duas instâncias não apagam a mesma empresa) e espera até 10 s pelo lock `vagas:<id>` (preenchimento de vagas). Se não conseguir, adia para o dia seguinte. Falhas avisam os Super Admins no sino.
6. **Backups**: os backups cifrados (secção 1) expiram em **14 dias**. O apagamento chega aos backups nesse prazo, e uma restauração feita antes disso traria os dados de volta: não restaurar um backup anterior ao apagamento sem voltar a correr a eliminação.

Por pessoa (a cargo do gestor da empresa): *Equipa > Exportar dados / Apagar dados pessoais*, e *O meu perfil > Descarregar os meus dados* para o próprio. O apagamento anonimiza a conta (mesma regra das contas eliminadas), apaga notificações e ausências, retira a pessoa das tarefas futuras (voltam a `por_atribuir` pelo fluxo normal) e mantém as tarefas passadas sem identificação.
