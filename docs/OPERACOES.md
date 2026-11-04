# Operações (backup e ping) — All2gether

Custo zero: GitHub Actions (backup) + um cron externo grátis (ping). Sem staging nem plano pago.

## 1. Backup diário do MongoDB

Workflow: `.github/workflows/backup.yml` (todos os dias às 03:17 UTC e manual em *Actions > Backup MongoDB > Run workflow*). Faz `mongodump --archive --gzip`, cifra com AES-256 (`gpg --symmetric`) dentro do runner e guarda só o ficheiro cifrado como artifact durante 14 dias. Falha de forma visível (job vermelho) se o dump falhar ou vier vazio.

### Configurar (uma vez)
1. GitHub > repositório > *Settings > Secrets and variables > Actions > New repository secret*:
   - `MONGODB_URI`: URI do Atlas. Recomendado: um utilizador de BD só com leitura (role `read` na base) criado só para o backup.
   - `BACKUP_PASSPHRASE`: frase longa e aleatória. **Guarda-a também fora do GitHub** (gestor de palavras-passe); sem ela o backup não se restaura.
2. Atlas > *Network Access*: os runners do GitHub não têm IP fixo, por isso o Atlas tem de aceitar a ligação deles (`0.0.0.0/0` é a única opção grátis; mitiga-se com o utilizador só de leitura e palavra-passe forte). Sem isto o workflow falha na ligação.
3. O workflow **agendado só corre depois de estar na branch `main`** (limitação do GitHub). Até lá, só o disparo manual na branch onde existir.
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

## 2. Ping para o Render não adormecer

O Render grátis adormece após inatividade. Usa um serviço externo, **não** o GitHub Actions (gastaria minutos).
1. Cria conta grátis em [cron-job.org](https://cron-job.org).
2. Novo cron job: URL `https://all2gether-backend.onrender.com/api/health`, método GET, de 10 em 10 minutos.
3. Opcional: ativa a notificação por email em caso de falha.

## 3. Reconciliação do Smoobu (opcional)
Rede de segurança dos webhooks, desligada por defeito. Para ativar numa empresa: *Configurações > Integrações > Rotinas* (sincronização automática + frequência em horas, mínimo 1). Ver `docs/BACKEND.md`.
