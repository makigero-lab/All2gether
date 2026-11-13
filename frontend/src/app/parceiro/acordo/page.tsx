"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EcraAcordo } from "@/components/parceiro/acordo-dados";

/** Ecrã do Acordo de Tratamento de Dados (art. 28.º RGPD) no portal do proprietário. */
export default function ParceiroAcordoPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <Link href="/parceiro/calendarios" className="inline-flex min-h-11 items-center gap-1 text-sm text-brand-text hover:underline sm:min-h-9"><ArrowLeft className="h-4 w-4" /> Voltar aos calendários</Link>
      <EcraAcordo />
    </main>
  );
}
