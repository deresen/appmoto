import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Link, LoaderCircle, Share2 } from "lucide-react";
import type { Report } from "./types";
import { buildReportShareUrl, validReportId } from "./reportSharing";
import "./sharing.css";

function cancelled(error: unknown) {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "AbortError";
}

export default function ReportShare({
  report,
  categoryLabel,
}: {
  report: Report;
  categoryLabel: string;
}) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [manual, setManual] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const operation = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    operation.current += 1;
    busy.current = false;
    setWorking(false);
    setMessage("");
    setManual(false);
    return () => {
      operation.current += 1;
      busy.current = false;
    };
  }, [report.id]);

  useEffect(() => {
    if (manual) {
      input.current?.focus();
      input.current?.select();
    }
  }, [manual]);

  const shareable = report.source === "community" && !report.resolvedAt &&
    Date.parse(report.expiresAt) > Date.now() && validReportId(report.id);
  let url = "";
  if (shareable && typeof window !== "undefined") {
    try { url = buildReportShareUrl(window.location.origin, report.id); }
    catch { /* A non-HTTP preview cannot provide a public link. */ }
  }

  async function copyLink(token: number) {
    if (operation.current !== token) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard non disponibile.");
      await navigator.clipboard.writeText(url);
      if (operation.current === token) {
        setManual(false);
        setMessage("Link copiato. Puoi incollarlo su WhatsApp o dove preferisci.");
      }
    } catch {
      if (operation.current === token) {
        setManual(true);
        setMessage("La copia automatica non è disponibile. Seleziona il link e copialo dal browser.");
      }
    }
  }

  async function share(copyOnly = false) {
    if (busy.current || !shareable || !url) return;
    busy.current = true;
    const token = ++operation.current;
    setWorking(true);
    setMessage("");
    try {
      const data: ShareData = {
        title: `${categoryLabel} · Passo`,
        text: `${categoryLabel} · ${report.location}\nSegnalazione della community su Passo.`,
        url,
      };
      let native = false;
      if (!copyOnly && typeof navigator.share === "function") {
        try { native = !navigator.canShare || navigator.canShare(data); }
        catch { /* Unsupported data uses the copy fallback. */ }
      }
      if (native) {
        try {
          await navigator.share(data);
          if (operation.current === token) setMessage("Condivisione completata.");
          return;
        } catch (error) {
          // Cancelling the system sheet does not mean the report was shared.
          if (cancelled(error)) return;
        }
      }
      await copyLink(token);
    } finally {
      if (operation.current === token) {
        busy.current = false;
        setWorking(false);
      }
    }
  }

  if (!shareable || !url) return null;
  return (
    <section className="report-share" aria-label="Condividi questa segnalazione">
      <p className="report-share-intro">Condividi il punto con chi percorrerà questa strada.</p>
      <div className="report-share-actions">
        <button type="button" className="report-share-primary" disabled={working} onClick={() => void share()}>
          {working ? <LoaderCircle size={17} className="spin" /> : <Share2 size={17} />}
          Condividi segnalazione
        </button>
        <button type="button" className="report-share-copy" disabled={working} onClick={() => void share(true)}>
          <Copy size={16} />Copia link
        </button>
      </div>
      <p className="report-share-status" role="status" aria-live="polite">
        {message && <>{manual ? <Link size={15} /> : <Check size={15} />}<span>{message}</span></>}
      </p>
      {manual && (
        <div className="report-share-manual">
          <label htmlFor={inputId}><Link size={14} />Link della segnalazione</label>
          <input id={inputId} ref={input} type="url" readOnly value={url} spellCheck={false}
            autoComplete="off" onFocus={(event) => event.currentTarget.select()} />
          <button type="button" onClick={() => { input.current?.focus(); input.current?.select(); }}>
            Seleziona link
          </button>
        </div>
      )}
    </section>
  );
}
