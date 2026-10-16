import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Card } from "@/components/ui";

// Piezas de la pagina Manual: secciones con ancla, pasos numerados, bloques de codigo copiables y avisos.

export function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="scroll-mt-6">
      <Card className="p-5 md:p-6">
        <h2 id={`${id}-titulo`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {intro && <div className="mt-1 text-sm text-muted">{intro}</div>}
        <div className="mt-4 space-y-4">{children}</div>
      </Card>
    </section>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-3 text-sm [counter-reset:paso]">{children}</ol>;
}

export function Step({ children }: { children: ReactNode }) {
  return (
    <li className="relative pl-9 leading-relaxed [counter-increment:paso] before:absolute before:left-0 before:top-0 before:flex before:size-6 before:items-center before:justify-center before:rounded-full before:bg-primary/10 before:text-xs before:font-semibold before:text-primary before:content-[counter(paso)]">
      {children}
    </li>
  );
}

/** Bloque de texto para copiar (lineas del .env, comandos, direcciones). */
export function Code({ text, label }: { text: string; label?: string }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-background p-2.5">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">{text}</pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

const CALLOUT = {
  info: "border-primary/30 bg-primary/5",
  warning: "border-warning/40 bg-warning-bg",
  success: "border-success/40 bg-success-bg",
} as const;

export function Callout({ tone = "info", title, children }: { tone?: keyof typeof CALLOUT; title?: string; children: ReactNode }) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm leading-relaxed ${CALLOUT[tone]}`}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** Texto en negrita para nombres de botones y menus tal como se ven en pantalla. */
export function UI({ children }: { children: ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">
      {children}
    </a>
  );
}

/** Un problema frecuente: el mensaje tal como aparece, que significa y como se arregla. */
export function Problem({ message, children }: { message: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-surface open:bg-background/50">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 text-sm font-medium marker:hidden">
        <span aria-hidden="true" className="mt-0.5 text-muted transition-transform group-open:rotate-90">
          ▸
        </span>
        <span>{message}</span>
      </summary>
      <div className="space-y-2 border-t border-border px-4 py-3 pl-10 text-sm leading-relaxed">{children}</div>
    </details>
  );
}
