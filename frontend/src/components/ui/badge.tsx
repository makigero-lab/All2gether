import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // Estados (cor forte + fundo suave, tokens --status-* em globals.css).
        // Usar sempre com ícone + texto (ver <EstadoTarefaBadge/>): a cor nunca é o único sinal.
        porAtribuir: "border-current bg-status-porat-bg text-status-porat",
        naoAtribuida: "border-current bg-status-naoat-bg text-status-naoat",
        atribuida: "border-current bg-status-atrib-bg text-status-atrib",
        emCurso: "border-current bg-status-curso-bg text-status-curso",
        concluida: "border-current bg-status-conc-bg text-status-conc",
        cancelada: "border-current border-dashed bg-status-canc-bg text-status-canc",
        // Aliases genéricos (mesmas cores): sucesso = concluída, aviso = por atribuir.
        success: "border-current bg-status-conc-bg text-status-conc",
        warning: "border-current bg-status-porat-bg text-status-porat",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
