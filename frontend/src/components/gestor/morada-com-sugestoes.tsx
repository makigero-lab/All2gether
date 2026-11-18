"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { carregarGoogleMaps, googleMapsDisponivel } from "@/lib/google-maps";
import { limparPais, tiposDoLugar, type EscolhaMorada } from "@/lib/sugestoes-morada";

interface Sugestao {
  principal: string;
  secundario: string;
  previsao: google.maps.places.PlacePrediction;
}

const MIN_CARACTERES = 3;
const ATRASO_MS = 250;

/**
 * Campo de morada com sugestões do Google (Places API New, só Portugal).
 * Sem NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY é só o campo recebido, sem nada extra
 * e sem carregar o Google. O script só é pedido ao focar o campo.
 *
 * Ao escolher: preenche o texto (formattedAddress sem «, Portugal») e entrega
 * {lat, lng, tipos}. Se o utilizador voltar a escrever, entrega null (descarta).
 * Pedido ao Google: só location, formattedAddress, addressComponents (Essentials),
 * com session token (um por pesquisa; termina ao escolher).
 */
export function MoradaComSugestoes({
  id,
  value,
  onChange,
  onEscolher,
  Campo,
  bloquearEnter = false,
  ...resto
}: {
  id: string;
  value: string;
  onChange: (texto: string) => void;
  onEscolher: (escolha: EscolhaMorada | null) => void;
  /** Componente do campo (Input ou textarea do projeto). */
  Campo: React.ElementType;
  /** Campo multilinha que não aceita Enter (o Enter fecha/escolhe a sugestão). */
  bloquearEnter?: boolean;
  [k: string]: unknown;
}) {
  const ativo = googleMapsDisponivel();
  const idLista = `${useId()}-sugestoes`;
  const [sugestoes, setSugestoes] = useState<Sugestao[]>([]);
  const [aberta, setAberta] = useState(false);
  const [indice, setIndice] = useState(-1);
  const token = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pedido = useRef(0);
  const [escolhendo, setEscolhendo] = useState(false);

  useEffect(() => () => { if (temporizador.current) clearTimeout(temporizador.current); }, []);

  if (!ativo) {
    return <Campo id={id} value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} {...resto} />;
  }

  async function procurar(texto: string) {
    const meu = ++pedido.current;
    try {
      const gm = await carregarGoogleMaps();
      const { AutocompleteSuggestion, AutocompleteSessionToken } = (await gm.importLibrary("places")) as google.maps.PlacesLibrary;
      if (!token.current) token.current = new AutocompleteSessionToken();
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: texto,
        includedRegionCodes: ["pt"],
        language: "pt-PT",
        region: "pt",
        sessionToken: token.current,
      });
      if (meu !== pedido.current) return; // resposta antiga
      const lista = suggestions
        .filter((s) => s.placePrediction)
        .slice(0, 6)
        .map((s) => ({
          principal: s.placePrediction!.mainText?.text ?? s.placePrediction!.text.text,
          secundario: s.placePrediction!.secondaryText?.text ?? "",
          previsao: s.placePrediction!,
        }));
      setSugestoes(lista);
      setIndice(-1);
      setAberta(lista.length > 0);
    } catch {
      if (meu === pedido.current) {
        setSugestoes([]);
        setAberta(false);
      }
    }
  }

  function aoEscrever(texto: string) {
    onChange(texto);
    onEscolher(null); // o texto mudou: a escolha anterior deixa de valer
    if (temporizador.current) clearTimeout(temporizador.current);
    if (texto.trim().length < MIN_CARACTERES) {
      pedido.current++;
      setSugestoes([]);
      setAberta(false);
      return;
    }
    temporizador.current = setTimeout(() => void procurar(texto.trim()), ATRASO_MS);
  }

  async function escolher(s: Sugestao) {
    setEscolhendo(true);
    setAberta(false);
    try {
      const lugar = s.previsao.toPlace();
      await lugar.fetchFields({ fields: ["location", "formattedAddress", "addressComponents"] });
      token.current = null; // a sessão termina aqui
      if (lugar.location && lugar.formattedAddress) {
        onChange(limparPais(lugar.formattedAddress));
        onEscolher({
          lat: lugar.location.lat(),
          lng: lugar.location.lng(),
          tipos: tiposDoLugar(s.previsao.types, lugar.addressComponents),
        });
      }
    } catch {
      /* mantém o texto que o utilizador tinha */
    } finally {
      setEscolhendo(false);
      setSugestoes([]);
    }
  }

  function aoTeclar(e: React.KeyboardEvent) {
    if (aberta && sugestoes.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setIndice((i) => (i + 1) % sugestoes.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setIndice((i) => (i <= 0 ? sugestoes.length - 1 : i - 1)); return; }
      if (e.key === "Enter" && indice >= 0) { e.preventDefault(); void escolher(sugestoes[indice]); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAberta(false); return; }
    }
    if (e.key === "Enter" && bloquearEnter) e.preventDefault();
  }

  return (
    <div className="relative">
      <Campo
        id={id}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => aoEscrever(e.target.value)}
        onFocus={() => { void carregarGoogleMaps().catch(() => undefined); }}
        onBlur={() => setTimeout(() => setAberta(false), 120)}
        onKeyDown={aoTeclar}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={aberta}
        aria-controls={idLista}
        aria-activedescendant={aberta && indice >= 0 ? `${idLista}-${indice}` : undefined}
        autoComplete="off"
        aria-busy={escolhendo || undefined}
        {...resto}
      />
      {aberta && sugestoes.length > 0 && (
        <ul
          id={idLista}
          role="listbox"
          aria-label="Sugestões de morada"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {sugestoes.map((s, i) => (
            <li
              key={`${s.principal}-${i}`}
              id={`${idLista}-${i}`}
              role="option"
              aria-selected={i === indice}
              // mousedown (não click): o campo não perde o foco antes de escolher
              onMouseDown={(e) => { e.preventDefault(); void escolher(s); }}
              onMouseEnter={() => setIndice(i)}
              className={cn("flex min-h-11 cursor-pointer flex-col justify-center px-3 py-1.5 text-sm sm:min-h-9", i === indice && "bg-muted")}
            >
              <span className="font-medium">{s.principal}</span>
              {s.secundario && <span className="text-xs text-muted-foreground">{s.secundario}</span>}
            </li>
          ))}
          <li role="presentation" className="px-3 pb-1 pt-1 text-right text-xs text-muted-foreground">Sugestões do Google</li>
        </ul>
      )}
      <span className="sr-only" role="status">
        {aberta ? `${sugestoes.length} sugestões de morada. Usa as setas para escolher.` : ""}
      </span>
    </div>
  );
}
