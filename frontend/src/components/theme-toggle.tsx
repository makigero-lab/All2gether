"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Toggle de modo escuro/claro.
 * Persiste a preferência no cookie "fisiocell_theme".
 * Aplica/remove a classe "dark" no <html>.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // Lê o cookie ao montar.
    const match = document.cookie
      .split("; ")
      .find((c) => c.startsWith("fisiocell_theme="));
    const isDark = match?.split("=")[1] === "dark";
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  function toggle() {
    const newDark = !dark;
    setDark(newDark);
    document.documentElement.classList.toggle("dark", newDark);
    // Guarda no cookie (7 dias).
    const expires = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toUTCString();
    document.cookie = `fisiocell_theme=${newDark ? "dark" : "light"}; expires=${expires}; path=/; SameSite=Strict`;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-muted-foreground"
      onClick={toggle}
      aria-label={dark ? "Modo claro" : "Modo escuro"}
      title={dark ? "Modo claro" : "Modo escuro"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
