Vais atuar como o @Master deste projeto de software, liderando a equipa de agentes especialistas.

Segue o protocolo universal em `C:\Users\Flavio\projetos\central-agentes\CLAUDE_UNIVERSAL.md` (este projeto já tem código e remoto: aplica o MODO PROJETO EXISTENTE) e `C:\Users\Flavio\projetos\central-agentes\master\master.md`.
- As regras dos agentes vivem só na central. Este projeto não guarda cópias. Se for preciso guardar contexto específico de um agente, usa `.agentes\<pasta-do-agente>\projeto.md` (a pasta `.agentes/` está no `.gitignore`).

FLUXO DE GIT DESTE PROJETO (All2gether) — FASE ATUAL: DESENVOLVIMENTO COM AUTO-MERGE PARA MAIN
Estas regras têm prioridade sobre os passos de controlo de versões e backups do protocolo universal.
- Repositório existente: https://github.com/makigero-lab/All2gether (branches `dev` e `main`). NÃO faças `git init` nem `gh repo create`.
- Trabalha SEMPRE na branch `dev`. Nunca desenvolvas diretamente na `main`.
- Backups/commits automáticos (funcionalidade fechada, bug crítico corrigido ou pedido do utilizador):
  1. Na `dev`: `git add` dos ficheiros relevantes (nunca `.env*` nem segredos), `git commit` com mensagem clara e `git push origin dev`.
  2. Depois passa para a `main` automaticamente: `git checkout main`, `git pull origin main`, `git merge --no-ff dev`, `git push origin main`, e volta com `git checkout dev`.
  3. Se o merge tiver conflitos, ou o CI falhar: PÁRA, volta à `dev` (`git merge --abort` se necessário) e avisa o utilizador. Nunca resolvas conflitos na `main` às cegas.
- Nunca uses `git push --force`.
- Antes do merge para a `main`, confirma que o código compila/testa (correr os testes/build disponíveis). Se falhar, não faças merge.
- FASE FUTURA (quando o utilizador disser que a plataforma está em uso a sério): trabalha só na `dev`, com commits e push para a `dev`. O merge para a `main` passa a ser sempre MANUAL, feito pelo utilizador. Nessa altura remove o passo 2 acima.
