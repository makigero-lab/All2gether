"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { carregarGoogleMaps } from "@/lib/google-maps";
import { LISBOA } from "@/lib/sugestoes-morada";

/**
 * Mapa com um pino arrastável para a gestora acertar «até à porta».
 * Satélite/híbrido por defeito (alternável), zoom 18. Sem coordenadas abre em
 * Lisboa com um aviso. Usa AdvancedMarker com o mapId DEMO_MAP_ID, que funciona
 * sem configurar nada na consola do Google (para estilos próprios seria preciso
 * um mapId real).
 */
export function MapaPino({
  centro,
  onCancelar,
  onUsar,
}: {
  centro: { lat: number; lng: number } | null;
  onCancelar: () => void;
  onUsar: (lat: number, lng: number) => void;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const [estado, setEstado] = useState<"a-carregar" | "pronto" | "erro">("a-carregar");
  const [posicao, setPosicao] = useState<{ lat: number; lng: number } | null>(centro);
  const [mexeu, setMexeu] = useState(false);
  const inicio = useRef(centro);

  useEffect(() => {
    let cancelado = false;
    const limpeza: Array<() => void> = [];
    (async () => {
      try {
        const gm = await carregarGoogleMaps();
        const { Map } = (await gm.importLibrary("maps")) as google.maps.MapsLibrary;
        const { AdvancedMarkerElement } = (await gm.importLibrary("marker")) as google.maps.MarkerLibrary;
        if (cancelado || !divRef.current) return;
        const ponto = inicio.current ?? LISBOA;
        const mapa = new Map(divRef.current, {
          center: ponto,
          zoom: inicio.current ? 18 : 14,
          mapTypeId: "hybrid",
          mapId: "DEMO_MAP_ID",
          mapTypeControl: true,
          streetViewControl: false,
          fullscreenControl: false,
          gestureHandling: "greedy",
        });
        const pino = new AdvancedMarkerElement({ map: mapa, position: ponto, gmpDraggable: true, title: "Arrasta até à porta" });
        const mover = (lat: number, lng: number) => {
          setPosicao({ lat, lng });
          setMexeu(true);
        };
        const aoLargar = () => {
          const p = pino.position as google.maps.LatLng | google.maps.LatLngLiteral | null | undefined;
          if (!p) return;
          const lat = typeof (p as google.maps.LatLng).lat === "function" ? (p as google.maps.LatLng).lat() : (p as google.maps.LatLngLiteral).lat;
          const lng = typeof (p as google.maps.LatLng).lng === "function" ? (p as google.maps.LatLng).lng() : (p as google.maps.LatLngLiteral).lng;
          mover(lat, lng);
        };
        // «gmp-dragend» é um evento DOM do elemento (os addListener estão obsoletos nos AdvancedMarker).
        pino.addEventListener("gmp-dragend", aoLargar);
        // Tocar no mapa também põe lá o pino (mais fácil no telemóvel).
        const aoClicar = mapa.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          pino.position = e.latLng;
          mover(e.latLng.lat(), e.latLng.lng());
        });
        limpeza.push(() => { pino.removeEventListener("gmp-dragend", aoLargar); aoClicar.remove(); pino.map = null; });
        setEstado("pronto");
      } catch {
        if (!cancelado) setEstado("erro");
      }
    })();
    return () => { cancelado = true; limpeza.forEach((f) => f()); };
  }, []);

  return (
    <div className="space-y-2 rounded-md border p-2">
      <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
        {inicio.current ? "Arrasta o pino até à porta (ou toca no mapa). Podes alternar entre mapa e satélite." : (
          <>
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-porat" aria-hidden="true" />
            <span>Esta casa ainda não tem localização: o mapa abre em Lisboa. Arrasta o pino até à porta.</span>
          </>
        )}
      </p>
      <div className="relative">
        <div ref={divRef} className="h-72 w-full rounded-md bg-muted sm:h-96" role="application" aria-label="Mapa com o pino da casa" />
        {estado === "a-carregar" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />A carregar o mapa…
          </div>
        )}
        {estado === "erro" && (
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-destructive" role="alert">
            Não foi possível carregar o mapa. Podes indicar a localização colando as coordenadas ou o link.
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancelar}>Cancelar</Button>
        <Button type="button" disabled={estado !== "pronto" || !posicao || (!inicio.current && !mexeu)} onClick={() => posicao && onUsar(posicao.lat, posicao.lng)}>
          Usar esta posição
        </Button>
      </div>
    </div>
  );
}
