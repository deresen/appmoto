import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownWideNarrow,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  CircleOff,
  Construction,
  Crosshair,
  Droplets,
  Flag,
  Info,
  Layers,
  LoaderCircle,
  LocateFixed,
  Map,
  MapPin,
  Navigation,
  Plus,
  Radio,
  Route,
  Search,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  TriangleAlert,
  Waves,
  X,
} from "lucide-react";
import MapView from "./MapView";
import type { Category, NewReport, Report, Severity } from "./types";

const CATEGORIES = {
  pothole: {
    label: "Buche",
    singular: "Buca",
    icon: CircleOff,
    color: "#c27919",
  },
  gravel: {
    label: "Ghiaia",
    singular: "Ghiaia",
    icon: Layers,
    color: "#96723e",
  },
  oil: {
    label: "Olio",
    singular: "Olio sulla strada",
    icon: Droplets,
    color: "#8060b6",
  },
  obstacle: {
    label: "Ostacoli",
    singular: "Ostacolo",
    icon: TriangleAlert,
    color: "#d36927",
  },
  closure: {
    label: "Chiusure",
    singular: "Strada chiusa",
    icon: Construction,
    color: "#c34e52",
  },
} as const;
const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];
type Position = { latitude: number; longitude: number };
type Bounds = { north: number; south: number; east: number; west: number };
type Draft = {
  category: Category;
  location: string;
  description: string;
  severity: Severity;
  position: Position | null;
};
const EMPTY_DRAFT: Draft = {
  category: "pothole",
  location: "",
  description: "",
  severity: "attention",
  position: null,
};

function ago(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  if (minutes < 1) return "Adesso";
  if (minutes < 60) return `${minutes} min fa`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "ora" : "ore"} fa`;
}

function searchable(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("it");
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  }).catch(() => {
    throw new Error(
      "Connessione non disponibile. Controlla la rete e riprova.",
    );
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Non è stato possibile completare la richiesta. Riprova.",
    );
  return data as T;
}

function Dialog({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const element = ref.current;
    element?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const focusable = element?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, a[href], [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === element)
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">PASSO COMMUNITY</span>
            <h2>{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Chiudi finestra"
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function CategoryIcon({
  category,
  size = 21,
}: {
  category: Category;
  size?: number;
}) {
  const Icon = CATEGORIES[category].icon;
  return (
    <span className={`category-icon category-icon--${category}`}>
      <Icon size={size} strokeWidth={1.8} />
    </span>
  );
}

export default function App() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [connection, setConnection] = useState<
    "connecting" | "live" | "offline"
  >("connecting");
  const [reload, setReload] = useState(0);
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const [showDemo, setShowDemo] = useState(true);
  const [sort, setSort] = useState("recent");
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [target, setTarget] = useState<
    (Position & { zoom?: number; key: number }) | null
  >(null);
  const [mobileView, setMobileView] = useState<"map" | "list">("map");
  const [dialog, setDialog] = useState<
    "new" | "detail" | "about" | "privacy" | null
  >(null);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT });
  const positionBeforePicking = useRef<Position | null>(null);
  const [picking, setPicking] = useState(false);
  const [formError, setFormError] = useState("");
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [locating, setLocating] = useState(false);
  const [toast, setToast] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    let events: EventSource | null = null;
    setLoading(true);
    setLoadError("");
    setConnection("connecting");
    async function connect() {
      try {
        const initial = await api<{ reports: Report[] }>("/api/reports");
        if (!active) return;
        setReports(initial.reports);
        setLoading(false);
        events = new EventSource("/api/events", { withCredentials: true });
        events.onopen = () => {
          if (active) setConnection("live");
        };
        events.onerror = () => {
          if (active) setConnection("offline");
        };
        events.addEventListener("reports", (event) => {
          if (!active) return;
          try {
            const data = JSON.parse((event as MessageEvent).data) as {
              reports: Report[];
            };
            if (Array.isArray(data.reports)) {
              setReports(data.reports);
              setConnection("live");
            }
          } catch {
            setConnection("offline");
          }
        });
      } catch (error) {
        if (active) {
          setLoading(false);
          setConnection("offline");
          setLoadError(
            error instanceof Error
              ? error.message
              : "Connessione non disponibile.",
          );
        }
      }
    }
    void connect();
    return () => {
      active = false;
      events?.close();
    };
  }, [reload]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const activeReports = reports.filter(
    (report) => new Date(report.expiresAt).getTime() > Date.now(),
  );
  const baseReports = activeReports.filter(
    (report) => showDemo || report.source !== "demo",
  );
  const filtered = baseReports.filter((report) => {
    const matchesCategory = category === "all" || report.category === category;
    const text = searchable(
      `${report.location} ${report.description} ${CATEGORIES[report.category].label}`,
    );
    return matchesCategory && text.includes(searchable(query.trim()));
  });
  const visible = filtered
    .filter(
      (report) =>
        query.trim() ||
        !bounds ||
        (report.latitude <= bounds.north &&
          report.latitude >= bounds.south &&
          report.longitude <= bounds.east &&
          report.longitude >= bounds.west),
    )
    .sort((a, b) =>
      sort === "confirmed"
        ? b.confirmations - a.confirmations ||
          Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const selected = reports.find((report) => report.id === selectedId);
  const communityCount = activeReports.filter(
    (report) => report.source === "community",
  ).length;

  function focusReport(report: Report, open = true) {
    setSelectedId(report.id);
    setTarget({
      latitude: report.latitude,
      longitude: report.longitude,
      zoom: 14,
      key: Date.now(),
    });
    if (open) {
      setDialog("detail");
      setConfirmError("");
    }
  }
  function openNew() {
    setFormError("");
    setPicking(false);
    setDialog("new");
  }
  function getPosition(forReport = false) {
    if (!navigator.geolocation) {
      setToast(
        "Questo browser non supporta la posizione. Scegli un punto sulla mappa.",
      );
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setTarget({ ...point, zoom: 15, key: Date.now() });
        if (forReport) {
          setDraft((previous) => ({ ...previous, position: point }));
          setFormError("");
        }
        setLocating(false);
      },
      (error) => {
        setLocating(false);
        const message =
          error.code === 1
            ? "Posizione non autorizzata. Puoi scegliere un punto sulla mappa."
            : "Posizione non disponibile. Scegli un punto sulla mappa.";
        if (forReport) setFormError(message);
        else setToast(message);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  }
  async function submitReport(event: FormEvent) {
    event.preventDefault();
    if (!draft.position) {
      setFormError(
        "Scegli la posizione del pericolo sulla mappa o usa la tua posizione.",
      );
      return;
    }
    if (draft.location.trim().length < 3) {
      setFormError(
        "Indica la strada o un punto di riferimento (almeno 3 caratteri).",
      );
      return;
    }
    if (draft.description.trim().length < 10) {
      setFormError("Descrivi il pericolo con almeno 10 caratteri.");
      return;
    }
    setSending(true);
    setFormError("");
    try {
      const body: NewReport = {
        category: draft.category,
        severity: draft.severity,
        location: draft.location.trim(),
        description: draft.description.trim(),
        ...draft.position,
      };
      const { report } = await api<{ report: Report }>("/api/reports", body);
      setReports((previous) => [
        report,
        ...previous.filter((item) => item.id !== report.id),
      ]);
      setCategory("all");
      setQuery("");
      setMobileView("map");
      setSelectedId(report.id);
      setTarget({
        latitude: report.latitude,
        longitude: report.longitude,
        zoom: 14,
        key: Date.now(),
      });
      setDialog(null);
      setDraft({ ...EMPTY_DRAFT });
      setToast("Segnalazione pubblicata. Grazie per il tuo contributo!");
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Invio non riuscito. Riprova.",
      );
    } finally {
      setSending(false);
    }
  }
  async function confirmReport() {
    if (!selected || selected.confirmedByMe || confirming) return;
    setConfirming(true);
    setConfirmError("");
    try {
      const { report } = await api<{ report: Report }>(
        `/api/reports/${encodeURIComponent(selected.id)}/confirm`,
        {},
      );
      setReports((previous) =>
        previous.map((item) => (item.id === report.id ? report : item)),
      );
      setToast("Presenza confermata. La community è aggiornata.");
    } catch (error) {
      setConfirmError(
        error instanceof Error
          ? error.message
          : "Conferma non riuscita. Riprova.",
      );
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Passo, pagina iniziale">
          <span className="brand-symbol">
            <Route size={25} strokeWidth={2.5} />
          </span>
          <span>
            passo<span className="brand-dot">.</span>
          </span>
        </a>
        <nav className="header-nav" aria-label="Navigazione principale">
          <button
            className="nav-active"
            onClick={() => {
              setMobileView("map");
              document
                .getElementById("explore")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            Esplora la mappa
          </button>
          <button onClick={() => setDialog("about")}>
            Come funziona <ArrowUpRight size={14} />
          </button>
        </nav>
        <div className="header-right">
          <span className="header-community">
            <span className="live-dot" />
            Una strada. Una community.
          </span>
          <button className="primary-button header-report" onClick={openNew}>
            <Plus size={18} />
            Segnala<span className="desktop-word"> un pericolo</span>
          </button>
        </div>
      </header>

      <main>
        <section className="intro" aria-labelledby="main-title">
          <div>
            <div className="intro-label">
              <span />
              PER CHI AMA LA STRADA
            </div>
            <h1 id="main-title">
              La strada, <span>insieme.</span>
            </h1>
            <p>
              Quello che incontri può aiutare chi arriva dopo.
              <br className="mobile-break" /> Segnala, conferma, riparti.
            </p>
          </div>
          <div className="intro-note">
            <div className="intro-note-icon">
              <Navigation size={23} strokeWidth={1.6} />
            </div>
            <div>
              <strong>Un piccolo gesto, una strada migliore.</strong>
              <span>Pensata per i motociclisti. Utile a tutti.</span>
            </div>
          </div>
        </section>

        <section
          id="explore"
          className="explore"
          aria-label="Esplora le condizioni stradali"
        >
          <div className="explore-toolbar">
            <form
              className="search-box"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                if (filtered[0]) {
                  focusReport(filtered[0], false);
                  setMobileView("map");
                }
              }}
            >
              <Search size={19} />
              <input
                aria-label="Cerca nelle segnalazioni"
                placeholder="Cerca nelle segnalazioni…"
                enterKeyHint="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Cancella ricerca"
                  onClick={() => setQuery("")}
                >
                  <X size={16} />
                </button>
              )}
              <kbd>↵</kbd>
            </form>
            <button
              className="location-button"
              aria-label="Centra la mappa sulla mia posizione"
              title="Vicino a me"
              onClick={() => getPosition()}
              disabled={locating}
            >
              {locating ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <LocateFixed size={18} />
              )}
              <span>Vicino a me</span>
            </button>
            <div className="mobile-view-switch" aria-label="Vista risultati">
              <button
                aria-pressed={mobileView === "map"}
                className={mobileView === "map" ? "active" : ""}
                onClick={() => setMobileView("map")}
              >
                <Map size={17} />
                Mappa
              </button>
              <button
                aria-pressed={mobileView === "list"}
                className={mobileView === "list" ? "active" : ""}
                onClick={() => setMobileView("list")}
              >
                <ArrowDownWideNarrow size={17} />
                Elenco
              </button>
            </div>
          </div>

          <div className="filter-bar">
            <div
              className="category-filters"
              role="group"
              aria-label="Filtra per tipo di pericolo"
            >
              <button
                className={`filter-chip ${category === "all" ? "active" : ""}`}
                aria-pressed={category === "all"}
                onClick={() => setCategory("all")}
              >
                <span className="all-dot" />
                Tutte<span className="filter-count">{baseReports.length}</span>
              </button>
              {CATEGORY_KEYS.map((key) => {
                const Icon = CATEGORIES[key].icon;
                return (
                  <button
                    key={key}
                    className={`filter-chip ${category === key ? "active" : ""}`}
                    aria-pressed={category === key}
                    onClick={() => setCategory(key)}
                  >
                    <Icon size={16} />
                    {CATEGORIES[key].label}
                  </button>
                );
              })}
            </div>
            <div
              className={`connection-status connection-status--${connection}`}
              role="status"
            >
              <span className="live-dot" />
              {connection === "live"
                ? "Aggiornamenti in diretta"
                : connection === "offline"
                  ? "Riconnessione…"
                  : "Connessione…"}
            </div>
          </div>

          {loadError && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={18} />
              <span>Non riusciamo a caricare le segnalazioni. {loadError}</span>
              <button onClick={() => setReload((value) => value + 1)}>
                Riprova
              </button>
            </div>
          )}
          {!loadError && connection === "offline" && (
            <div className="connection-banner" role="status">
              <Radio size={17} />
              Aggiornamenti temporaneamente interrotti. Riconnessione automatica
              in corso.
              <button onClick={() => setReload((value) => value + 1)}>
                Riprova ora
              </button>
            </div>
          )}

          {picking && (
            <div className="picking-banner" role="status">
              <div>
                <Crosshair size={21} />
                <span>
                  <strong>Scegli il punto esatto</strong>
                  <small>
                    Tocca la mappa. Da tastiera, usa le frecce e premi Invio.
                  </small>
                </span>
              </div>
              <div>
                <button
                  className="text-button"
                  onClick={() => {
                    setDraft((previous) => ({
                      ...previous,
                      position: positionBeforePicking.current,
                    }));
                    setPicking(false);
                    setDialog("new");
                  }}
                >
                  Annulla
                </button>
                <button
                  className="primary-button"
                  disabled={!draft.position}
                  onClick={() => {
                    setPicking(false);
                    setDialog("new");
                  }}
                >
                  <Check size={17} />
                  Usa questo punto
                </button>
              </div>
            </div>
          )}

          <div
            className={`workspace mobile-view--${mobileView} ${picking ? "is-picking" : ""}`}
          >
            <div className="map-panel">
              <MapView
                reports={filtered}
                selectedId={selectedId}
                onSelect={(id) => {
                  const report = reports.find((item) => item.id === id);
                  if (report && !picking) {
                    setSelectedId(id);
                    setDialog("detail");
                    setConfirmError("");
                  }
                }}
                target={target}
                picking={picking}
                pickedPosition={draft.position}
                onPick={(position) =>
                  setDraft((previous) => ({ ...previous, position }))
                }
                onBoundsChange={setBounds}
              />
              <div className="map-area-label">
                <span className="map-area-icon">
                  <MapPin size={16} />
                </span>
                <div>
                  <strong>Esplora la tua prossima strada</strong>
                  <span>Sposta la mappa per scoprire le segnalazioni</span>
                </div>
              </div>
              <button
                className="map-reset icon-button"
                title="Torna al Lago di Garda"
                aria-label="Torna al Lago di Garda"
                onClick={() =>
                  setTarget({
                    latitude: 45.6,
                    longitude: 10.55,
                    zoom: 10,
                    key: Date.now(),
                  })
                }
              >
                <Navigation size={19} />
              </button>
              <div className="map-legend">
                <span>
                  <i className="legend-attention" />
                  Attenzione
                </span>
                <span>
                  <i className="legend-danger" />
                  Pericolo
                </span>
              </div>
              {loading && (
                <div className="map-loading">
                  <LoaderCircle className="spin" size={22} />
                  Caricamento segnalazioni…
                </div>
              )}
            </div>
            <aside
              className="reports-panel"
              aria-label="Elenco delle segnalazioni"
            >
              <div className="reports-heading">
                <div>
                  <span className="eyebrow">
                    {query.trim()
                      ? "RISULTATI DELLA RICERCA"
                      : "AREA VISUALIZZATA"}
                  </span>
                  <h2>
                    Segnalazioni in zona <span>{visible.length}</span>
                  </h2>
                </div>
                <span
                  className="small-live"
                  title={
                    connection === "live"
                      ? "Sincronizzazione in tempo reale attiva"
                      : "Sincronizzazione in attesa"
                  }
                >
                  <Radio size={16} />
                </span>
              </div>
              <div className="reports-sort">
                <span>
                  {loading
                    ? "Caricamento…"
                    : `${visible.length} ${visible.length === 1 ? "segnalazione attiva" : "segnalazioni attive"}`}
                </span>
                <label>
                  <span className="sr-only">Ordina segnalazioni</span>
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="recent">Più recenti</option>
                    <option value="confirmed">Più confermate</option>
                  </select>
                  <ChevronDown size={13} />
                </label>
              </div>
              <div className="report-list">
                {!loading && visible.length === 0 && (
                  <div className="empty-state">
                    <span>
                      <MapPin size={28} strokeWidth={1.4} />
                    </span>
                    <h3>Qui la strada è ancora da raccontare.</h3>
                    <p>
                      {query.trim()
                        ? "Nessuna segnalazione corrisponde alla ricerca. Prova un altro nome."
                        : "Non ci sono segnalazioni con questi filtri. Esplora la mappa o aggiungi il tuo contributo."}
                    </p>
                    <button className="text-button" onClick={openNew}>
                      Aggiungi una segnalazione <ArrowRight size={16} />
                    </button>
                  </div>
                )}
                {loading &&
                  [1, 2, 3].map((item) => (
                    <div className="skeleton-card" key={item}>
                      <span />
                      <div />
                      <div />
                    </div>
                  ))}
                {visible.map((report) => (
                  <button
                    className={`report-card ${selectedId === report.id ? "is-selected" : ""}`}
                    key={report.id}
                    onClick={() => focusReport(report)}
                    aria-label={`${CATEGORIES[report.category].singular}, ${report.location}, ${report.confirmations} conferme`}
                  >
                    <div className="report-card-top">
                      <div className="report-kind">
                        <CategoryIcon category={report.category} size={17} />
                        <span>{CATEGORIES[report.category].singular}</span>
                        {report.severity === "danger" && (
                          <span className="danger-dot" title="Pericolo" />
                        )}
                      </div>
                      <span className="report-time">
                        {ago(report.createdAt)}
                      </span>
                    </div>
                    <h3>{report.location}</h3>
                    <p>{report.description}</p>
                    <div className="report-card-bottom">
                      <span className="confirmation-count">
                        <ShieldCheck size={14} />
                        {report.confirmations}{" "}
                        {report.confirmations === 1 ? "conferma" : "conferme"}
                        {report.confirmedByMe && <Check size={13} />}
                      </span>
                      <span
                        className={`source-label ${report.source === "demo" ? "source-label--demo" : ""}`}
                      >
                        {report.source === "demo" ? "ESEMPIO" : "COMMUNITY"}
                      </span>
                      <ArrowUpRight className="report-arrow" size={17} />
                    </div>
                  </button>
                ))}
              </div>
              <div className="panel-invite">
                <span className="invite-icon">
                  <Flag size={21} strokeWidth={1.5} />
                </span>
                <div>
                  <strong>Il tuo contributo conta.</strong>
                  <p>Hai visto qualcosa? Fallo sapere.</p>
                </div>
                <button
                  className="icon-button"
                  aria-label="Aggiungi una segnalazione"
                  onClick={openNew}
                >
                  <Plus size={21} />
                </button>
              </div>
            </aside>
          </div>

          <div className="below-map">
            <div className="demo-note">
              <Info size={15} />
              <span>
                {showDemo
                  ? "Le segnalazioni “ESEMPIO” sono dimostrative."
                  : "Stai visualizzando solo le segnalazioni della community."}
              </span>
              <button onClick={() => setShowDemo((value) => !value)}>
                {showDemo ? "Nascondi esempi" : "Mostra esempi"}
              </button>
            </div>
            <span className="community-total">
              <ShieldCheck size={15} />
              {communityCount}{" "}
              {communityCount === 1
                ? "contributo della community"
                : "contributi della community"}
            </span>
          </div>
        </section>

        <section className="how-strip" aria-label="Come contribuire">
          <div className="how-heading">
            <span className="eyebrow">POCHI SECONDI. UN AIUTO CONCRETO.</span>
            <h2>
              Ogni strada ha una storia.
              <br />
              <span>Aggiungi la tua.</span>
            </h2>
            <button onClick={() => setDialog("about")}>
              Scopri come funziona <ArrowUpRight size={16} />
            </button>
          </div>
          <div className="how-step">
            <span className="step-number">01</span>
            <MapPin size={23} strokeWidth={1.5} />
            <h3>Hai notato un pericolo?</h3>
            <p>Indica il punto sulla mappa e racconta cosa hai incontrato.</p>
          </div>
          <div className="how-step">
            <span className="step-number">02</span>
            <ThumbsUp size={23} strokeWidth={1.5} />
            <h3>Ci sei passato anche tu?</h3>
            <p>
              Conferma le segnalazioni ancora presenti. Un tocco fa la
              differenza.
            </p>
          </div>
          <div className="how-step">
            <span className="step-number">03</span>
            <Waves size={23} strokeWidth={1.5} />
            <h3>La community si aggiorna.</h3>
            <p>
              Le informazioni si condividono in diretta, per viaggiare più
              consapevoli.
            </p>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-brand">
          <Route size={19} />
          <strong>passo.</strong>
          <span>La strada è di tutti. Prendiamocene cura.</span>
        </div>
        <div>
          <button onClick={() => setDialog("privacy")}>
            Privacy e posizione
          </button>
          <span className="footer-beta">PRIMA VERSIONE</span>
        </div>
      </footer>

      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={20} />
          <span>{toast}</span>
          <button aria-label="Chiudi messaggio" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}

      {dialog === "new" && (
        <Dialog
          title="Segnala un pericolo"
          onClose={() => {
            if (!sending) setDialog(null);
          }}
          className="new-report-dialog"
        >
          <form onSubmit={submitReport} noValidate>
            <div className="dialog-content report-form">
              <p className="dialog-intro">
                Un'informazione utile a chi percorrerà la tua stessa strada.
              </p>
              <fieldset>
                <legend>
                  <span>01</span>Che cosa hai incontrato?
                </legend>
                <div className="form-categories">
                  {CATEGORY_KEYS.map((key) => {
                    const Icon = CATEGORIES[key].icon;
                    return (
                      <button
                        type="button"
                        key={key}
                        aria-pressed={draft.category === key}
                        className={draft.category === key ? "active" : ""}
                        onClick={() =>
                          setDraft((previous) => ({
                            ...previous,
                            category: key,
                          }))
                        }
                      >
                        <Icon size={24} strokeWidth={1.6} />
                        <span>{CATEGORIES[key].label}</span>
                        {draft.category === key && (
                          <Check className="category-check" size={13} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <fieldset>
                <legend>
                  <span>02</span>Dove si trova?
                </legend>
                <div className="position-actions">
                  <button
                    type="button"
                    onClick={() => getPosition(true)}
                    disabled={locating}
                  >
                    {locating ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <LocateFixed size={17} />
                    )}
                    La mia posizione
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      positionBeforePicking.current = draft.position;
                      setDialog(null);
                      setPicking(true);
                      setMobileView("map");
                      window.setTimeout(
                        () =>
                          document
                            .getElementById("explore")
                            ?.scrollIntoView({ behavior: "smooth" }),
                        50,
                      );
                    }}
                  >
                    <Map size={17} />
                    Scegli sulla mappa
                  </button>
                </div>
                <div
                  className={`position-status ${draft.position ? "has-position" : ""}`}
                >
                  <MapPin size={15} />
                  {draft.position
                    ? `Punto selezionato: ${draft.position.latitude.toFixed(5)}, ${draft.position.longitude.toFixed(5)}`
                    : "Seleziona un punto preciso prima di pubblicare."}
                </div>
                <label className="field-label" htmlFor="location">
                  Strada o punto di riferimento
                </label>
                <input
                  id="location"
                  name="location"
                  autoComplete="off"
                  className="form-input"
                  maxLength={120}
                  placeholder="Es. SP572, dopo la rotonda di Salò"
                  value={draft.location}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      location: event.target.value,
                    }))
                  }
                />
              </fieldset>
              <fieldset>
                <legend>
                  <span>03</span>Aggiungi i dettagli
                </legend>
                <label className="field-label" htmlFor="description">
                  Cosa devono sapere gli altri?
                </label>
                <textarea
                  id="description"
                  name="description"
                  className="form-input"
                  rows={3}
                  maxLength={500}
                  placeholder="Descrivi il pericolo, la direzione e la corsia interessata…"
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      description: event.target.value,
                    }))
                  }
                />
                <div className="character-count">
                  {draft.description.length}/500
                </div>
                <span className="field-label">Livello di attenzione</span>
                <div className="severity-choices">
                  <button
                    type="button"
                    aria-pressed={draft.severity === "attention"}
                    className={draft.severity === "attention" ? "active" : ""}
                    onClick={() =>
                      setDraft((previous) => ({
                        ...previous,
                        severity: "attention",
                      }))
                    }
                  >
                    <span className="severity-dot" />
                    Attenzione
                    {draft.severity === "attention" && <Check size={15} />}
                  </button>
                  <button
                    type="button"
                    aria-pressed={draft.severity === "danger"}
                    className={`danger-choice ${draft.severity === "danger" ? "active" : ""}`}
                    onClick={() =>
                      setDraft((previous) => ({
                        ...previous,
                        severity: "danger",
                      }))
                    }
                  >
                    <TriangleAlert size={15} />
                    Pericolo elevato
                    {draft.severity === "danger" && <Check size={15} />}
                  </button>
                </div>
              </fieldset>
              {formError && (
                <div className="form-error" role="alert">
                  <TriangleAlert size={17} />
                  {formError}
                </div>
              )}
              <p className="form-privacy">
                <ShieldCheck size={14} />
                Condividiamo solo il punto scelto, non i tuoi spostamenti. La
                segnalazione scade dopo 24 ore.
              </p>
            </div>
            <div className="dialog-footer">
              <span>Segnala solo dopo esserti fermato.</span>
              <button
                className="primary-button"
                type="submit"
                disabled={sending || locating}
              >
                {sending ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Plus size={18} />
                )}
                {sending ? "Pubblicazione…" : "Pubblica segnalazione"}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {dialog === "detail" && (
        <Dialog
          title={
            selected
              ? CATEGORIES[selected.category].singular
              : "Segnalazione non più attiva"
          }
          onClose={() => setDialog(null)}
          className="detail-dialog"
        >
          {selected && new Date(selected.expiresAt).getTime() > Date.now() ? (
            <>
              <div className="dialog-content">
                <div className="detail-category">
                  <CategoryIcon category={selected.category} size={27} />
                  <span
                    className={`severity-badge ${selected.severity === "danger" ? "is-danger" : ""}`}
                  >
                    <span />
                    {selected.severity === "danger"
                      ? "Pericolo elevato"
                      : "Attenzione"}
                  </span>
                  <span className="detail-age">{ago(selected.createdAt)}</span>
                </div>
                <h3 className="detail-location">{selected.location}</h3>
                <p className="detail-description">{selected.description}</p>
                {selected.source === "demo" && (
                  <div className="demo-detail">
                    <Sparkles size={18} />
                    <div>
                      <strong>Segnalazione di esempio</strong>
                      <p>
                        Serve a esplorare Passo e non descrive le condizioni
                        reali della strada.
                      </p>
                    </div>
                  </div>
                )}
                <div className="detail-facts">
                  <div>
                    <MapPin size={17} />
                    <span>
                      Punto segnalato
                      <strong>
                        {selected.latitude.toFixed(5)},{" "}
                        {selected.longitude.toFixed(5)}
                      </strong>
                    </span>
                  </div>
                  <div>
                    <ShieldCheck size={17} />
                    <span>
                      Conferme della community
                      <strong>
                        {selected.confirmations}{" "}
                        {selected.confirmations === 1
                          ? "persona ha confermato"
                          : "persone hanno confermato"}
                        {selected.confirmedByMe ? ", te compreso" : ""}
                      </strong>
                    </span>
                  </div>
                  <div>
                    <Radio size={17} />
                    <span>
                      Visibile fino alle
                      <strong>
                        {new Date(selected.expiresAt).toLocaleTimeString(
                          "it-IT",
                          { hour: "2-digit", minute: "2-digit" },
                        )}{" "}
                        del{" "}
                        {new Date(selected.expiresAt).toLocaleDateString(
                          "it-IT",
                          { day: "numeric", month: "long" },
                        )}
                      </strong>
                    </span>
                  </div>
                </div>
                <div className="confirm-explainer">
                  <h4>Il pericolo è ancora presente?</h4>
                  <p>
                    Conferma se sei passato di qui e lo hai verificato. Aiuterai
                    chi arriva dopo.
                  </p>
                </div>
                {confirmError && (
                  <div className="form-error" role="alert">
                    <TriangleAlert size={17} />
                    {confirmError}
                  </div>
                )}
              </div>
              <div className="dialog-footer detail-footer">
                <span>
                  <ShieldCheck size={15} />
                  Una conferma per browser.
                </span>
                <button
                  className={`primary-button ${selected.confirmedByMe ? "confirmed-button" : ""}`}
                  onClick={confirmReport}
                  disabled={selected.confirmedByMe || confirming}
                >
                  {confirming ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : selected.confirmedByMe ? (
                    <CheckCheck size={18} />
                  ) : (
                    <ThumbsUp size={18} />
                  )}
                  {selected.confirmedByMe
                    ? "Hai confermato"
                    : confirming
                      ? "Conferma in corso…"
                      : "Confermo, è presente"}
                </button>
              </div>
            </>
          ) : (
            <div className="dialog-content empty-state">
              <CircleHelp size={32} />
              <h3>Questa segnalazione è scaduta.</h3>
              <p>
                Le segnalazioni rimangono visibili per 24 ore. Se il pericolo è
                ancora presente, puoi aggiungerne una nuova.
              </p>
              <button className="primary-button" onClick={openNew}>
                <Plus size={17} />
                Nuova segnalazione
              </button>
            </div>
          )}
        </Dialog>
      )}

      {dialog === "about" && (
        <Dialog
          title="La strada, vista da chi la percorre."
          onClose={() => setDialog(null)}
          className="info-dialog"
        >
          <div className="dialog-content">
            <p className="dialog-intro">
              Passo nasce per i motociclisti, ma ogni persona sulla strada può
              fare la differenza.
            </p>
            <div className="info-step">
              <span>01</span>
              <div>
                <h3>Segnala quello che incontri.</h3>
                <p>
                  Indica un punto preciso, scegli il tipo di pericolo e
                  descrivilo. La segnalazione viene condivisa subito.
                </p>
              </div>
            </div>
            <div className="info-step">
              <span>02</span>
              <div>
                <h3>Conferma quello che hai visto.</h3>
                <p>
                  Se un pericolo è ancora presente, confermalo. Ogni browser può
                  aggiungere una sola conferma per segnalazione.
                </p>
              </div>
            </div>
            <div className="info-step">
              <span>03</span>
              <div>
                <h3>Controlla quando è stato segnalato.</h3>
                <p>
                  Le segnalazioni scadono dopo 24 ore; le conferme non ne
                  prolungano la durata. Quelle contrassegnate “ESEMPIO” sono
                  dimostrative.
                </p>
              </div>
            </div>
            <div className="info-caution">
              <Info size={19} />
              <p>
                Le informazioni sono fornite dalla community e non sono
                verificate. Passo non sostituisce la segnaletica stradale o i
                servizi di emergenza.
              </p>
            </div>
          </div>
          <div className="dialog-footer">
            <button
              className="primary-button"
              onClick={() => {
                setDialog(null);
                document
                  .getElementById("explore")
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              Esplora la mappa <ArrowRight size={17} />
            </button>
          </div>
        </Dialog>
      )}

      {dialog === "privacy" && (
        <Dialog
          title="La tua posizione, sotto controllo."
          onClose={() => setDialog(null)}
          className="info-dialog"
        >
          <div className="dialog-content privacy-content">
            <p>
              Passo non segue i tuoi spostamenti. Chiede la posizione soltanto
              quando premi “Vicino a me” o “La mia posizione”, con il tuo
              consenso nel browser.
            </p>
            <h3>Cosa viene condiviso</h3>
            <p>
              Quando pubblichi, il punto che hai scelto, il tipo di pericolo e
              la descrizione diventano visibili agli altri. Non inserire nomi,
              numeri di telefono o altri dati personali nella descrizione.
            </p>
            <h3>Conferme e memoria del browser</h3>
            <p>
              Un cookie tecnico anonimo permette di riconoscere le tue conferme
              ed evitare duplicati nello stesso browser. Non è un account
              personale e non identifica in modo affidabile una persona.
            </p>
            <h3>La mappa</h3>
            <p>
              Le immagini della mappa sono richieste ai server di OpenStreetMap,
              che ricevono le normali informazioni di connessione e l’area
              visualizzata. Non vengono inviati loro il testo o i dettagli delle
              tue segnalazioni.
            </p>
            <a
              href="https://osmfoundation.org/wiki/Privacy_Policy"
              target="_blank"
              rel="noreferrer"
            >
              Privacy di OpenStreetMap <ArrowUpRight size={15} />
            </a>
            <p className="privacy-prototype">
              Questa è una prima versione dimostrativa: prima dell’uso pubblico
              serviranno gestione degli abusi, account e una politica completa
              su conservazione ed eliminazione dei dati.
            </p>
          </div>
        </Dialog>
      )}
    </>
  );
}
