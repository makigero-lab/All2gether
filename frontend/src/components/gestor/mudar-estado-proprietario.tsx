"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Power } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { adminGet, adminPatch } from "@/lib/api";

/** Resposta do PATCH de estado de um proprietário (casas e limpezas afetadas). */
interface RespostaEstado {
  casas_desativadas?: number;
  limpezas_canceladas?: number;
  pessoas_avisadas?: number;
  casas_reativadas?: number;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export interface PessoaEstado {
  _id: string;
  nome: string;
  ativo: boolean;
}

/**
 * Confirmação de desativar/reativar um proprietário (role "parceiro"). Partilhada pelas
 * páginas Proprietários e Equipa: explica o que acontece ANTES, com os números do servidor.
 * `pessoa` a null mantém o diálogo fechado.
 */
export function MudarEstadoProprietarioDialog({
  pessoa,
  onFechar,
  onConcluido,
}: {
  pessoa: PessoaEstado | null;
  onFechar: () => void;
  /** Chamado depois de gravar, com a mensagem de resultado para mostrar ao gestor. */
  onConcluido: (aviso: string) => void | Promise<void>;
}) {
  const [impacto, setImpacto] = useState<{ casas: number; limpezas: number } | null>(null);
  const [aCalcular, setACalcular] = useState(false);
  const [aGravar, setAGravar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const id = pessoa?._id;
  const ativo = pessoa?.ativo;
  useEffect(() => {
    setImpacto(null);
    setErro(null);
    setAGravar(false);
    if (!id || !ativo) {
      setACalcular(false);
      return;
    }
    let cancelado = false;
    setACalcular(true);
    adminGet<{ casas: number; limpezas: number }>(`/api/gestor/equipa/${id}/impacto-desativar`)
      .then((r) => { if (!cancelado) setImpacto(r); })
      // Sem os números a explicação continua a ser mostrada (sem contagens).
      .catch(() => undefined)
      .finally(() => { if (!cancelado) setACalcular(false); });
    return () => { cancelado = true; };
  }, [id, ativo]);

  function fechar() {
    if (!aGravar) onFechar();
  }

  async function confirmar() {
    if (!pessoa) return;
    setAGravar(true);
    setErro(null);
    try {
      const r = await adminPatch<RespostaEstado>(`/api/gestor/equipa/${pessoa._id}/estado`, { ativo: !pessoa.ativo });
      const aviso = pessoa.ativo
        ? `${pessoa.nome} foi desativado: ${plural(r.casas_desativadas ?? 0, "casa desativada", "casas desativadas")} e ${plural(r.limpezas_canceladas ?? 0, "limpeza cancelada", "limpezas canceladas")}.`
        : `${pessoa.nome} foi reativado: ${plural(r.casas_reativadas ?? 0, "casa reativada", "casas reativadas")}. As limpezas canceladas não foram recriadas.`;
      setAGravar(false);
      onFechar();
      await onConcluido(aviso);
    } catch (e) {
      setAGravar(false);
      setErro(e instanceof Error ? e.message : "Erro ao alterar estado.");
    }
  }

  return (
    <Dialog open={!!pessoa} onOpenChange={(o) => { if (!o) fechar(); }}>
      {pessoa && (
        <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Power className="h-5 w-5 text-brand-text" />
              {pessoa.ativo ? `Desativar ${pessoa.nome}?` : `Reativar ${pessoa.nome}?`}
            </DialogTitle>
            <DialogDescription>
              {pessoa.ativo
                ? "Confirma só depois de ler o que vai acontecer."
                : "As casas que foram desativadas com este proprietário voltam a ficar ativas."}
            </DialogDescription>
            <DialogClose onClick={fechar} />
          </DialogHeader>
          <DialogContent className="space-y-3 text-sm">
            {pessoa.ativo ? (
              <>
                {aCalcular ? (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />A calcular o que vai ser afetado…
                  </p>
                ) : impacto ? (
                  <p className="rounded-md border border-amber-300 bg-amber-50 p-3 font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                    Vão ser afetadas {plural(impacto.casas, "casa", "casas")} e{" "}
                    {plural(impacto.limpezas, "limpeza futura", "limpezas futuras")}.
                  </p>
                ) : (
                  <p className="text-muted-foreground">Não foi possível calcular quantas casas e limpezas serão afetadas.</p>
                )}
                <ul className="list-disc space-y-1.5 pl-5">
                  <li>
                    <strong>Todas as casas dele ficam inativas</strong>: deixam de receber limpezas, atribuições,
                    ofertas à equipa e reservas.
                  </li>
                  <li>
                    <strong>As limpezas futuras ainda não iniciadas dessas casas são canceladas</strong> e as pessoas da
                    equipa que as tinham são avisadas. As limpezas em curso ou concluídas não mudam.
                  </li>
                  <li>O proprietário deixa de poder entrar no portal.</li>
                  <li>
                    Se o reativares, as casas voltam a ficar ativas, mas <strong>as limpezas canceladas não são recriadas</strong>.
                  </li>
                </ul>
              </>
            ) : (
              <p>
                As limpezas que foram canceladas ao desativá-lo <strong>não são recriadas</strong>: terás de as criar de
                novo (ou o proprietário cria novas reservas).
              </p>
            )}
            {erro && (
              <p className="flex items-center gap-2 text-destructive" role="alert">
                <AlertCircle className="h-4 w-4" />
                {erro}
              </p>
            )}
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onFechar} disabled={aGravar}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant={pessoa.ativo ? "destructive" : "default"}
              onClick={confirmar}
              disabled={aGravar || aCalcular}
            >
              {aGravar ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />A gravar…</>
              ) : pessoa.ativo ? "Desativar proprietário" : "Reativar proprietário"}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
