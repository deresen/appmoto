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
  CloudRain,
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
  Radar,
  Route,
  Search,
  ShieldCheck,
  Shovel,
  Sparkles,
  ThumbsUp,
  TriangleAlert,
  Waves,
  X,
} from "lucide-react";
import MapView from "./MapView";
import type { Category, NewReport, Report, Severity } from "./types";
import {
  CLEAR_VOTE_THRESHOLD,
  CATEGORY_VALUES,
  DUPLICATE_RADIUS_METERS,
  distanceMeters,
  reportLifetimeMs,
} from "../shared/reportRules";

const CATEGORIES = {
  pothole: {
    label: "Buche",
    singular: "Buca",
    icon: CircleOff,
    color: "#c27919",
  },
  rough_road: {
    label: "Strada dissestata",
    singular: "Strada dissestata",
    icon: Waves,
    color: "#8b7548",
  },
  gravel: {
    label: "Ghiaia",
    singular: "Ghiaia",
    icon: Layers,
    color: "#96723e",
  },
  dirt: {
    label: "Terra",
    singular: "Terra sulla strada",
    icon: Shovel,
    color: "#99733f",
  },
  mud: {
    label: "Fango",
    singular: "Fango sulla strada",
    icon: CloudRain,
    color: "#8a6551",
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
  mobile_speed_camera: {
    label: "Autovelox mobile",
    singular: "Autovelox mobile",
    icon: Radar,
    color: "#397da0",
  },
  other: {
    label: "Altro pericolo",
    singular: "Altro pericolo",
    icon: CircleHelp,
    color: "#74857c",
  },
} as const;
const CATEGORY_KEYS = CATEGORY_VALUES;
type Position = { latitude: number; longitude: number };
type NearbyRadius = 5 | 10 | 25;
type NearbyArea = { position: Position; updatedAt: number };
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

function formatDistance(meters: number) {
  return meters < 1000
    ? `${Math.round(meters / 10) * 10} m`
    : `${(meters / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} km`;
}

function reportDuration(category: Category) {
  const hours = reportLifetimeMs(category) / 3_600_000;
  return hours === 1 ? "1 ora" : `${hours} ore`;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly duplicates?: Report[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isActive(report: Report) {
  return !report.resolvedAt && new Date(report.expiresAt).getTime() > Date.now();
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
    throw new ApiError(
      "Connessione non disponibile. Controlla la rete e riprova.",
      0,
    );
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      typeof data.error === "string"
        ? data.error
        : "Non è stato possibile completare la richiesta. Riprova.",
      response.status,
      typeof data.code === "string" ? data.code : undefined,
      Array.isArray(data.duplicates) ? data.duplicates : undefined,
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
  const [nearby, setNearby] = useState<NearbyArea | null>(null);
  const [nearbyRadius, setNearbyRadius] = useState<NearbyRadius>(10);
  const [nearbyPending, setNearbyPending] = useState(false);
  const [nearbyError, setNearbyError] = useState("");
  const nearbyRequest = useRef(0);
  const nearbyCurrent = useRef({ area: nearby, radius: nearbyRadius });
  nearbyCurrent.current = { area: nearby, radius: nearbyRadius };
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastSelected, setLastSelected] = useState<Report | null>(null);
  const [target, setTarget] = useState<
    (Position & { zoom?: number; radiusMeters?: number; key: number }) | null
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
  const [voting, setVoting] = useState<{ id: string; action: "confirm" | "clear" } | null>(null);
  const [confirmError, setConfirmError] = useState("");
  const [duplicateCandidates, setDuplicateCandidates] = useState<Report[] | null>(null);
  const [duplicateUnavailable, setDuplicateUnavailable] = useState<string[]>([]);
  const reportsRevision = useRef(0);
  // Resolution is terminal and report UUIDs are never reused. Only an explicit
  // resolvedAt creates a tombstone; absence from the capped list does not.
  const knownResolvedIds = useRef(new Set<string>());
  const submitInFlight = useRef(false);
  const voteInFlight = useRef(false);
  const duplicateRequestKey = useRef<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [toast, setToast] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => () => { nearbyRequest.current += 1; }, []);

  const draftKey = JSON.stringify(draft);
  const latestDraftKey = useRef(draftKey);
  latestDraftKey.current = draftKey;
  useEffect(() => {
    duplicateRequestKey.current = null;
    setDuplicateCandidates(null);
    setDuplicateUnavailable([]);
  }, [draftKey]);

  function receiveReports(next: Report[]) {
    reportsRevision.current += 1;
    for (const report of next) {
      if (report.resolvedAt) knownResolvedIds.current.add(report.id);
    }
    const active = next.filter((report) => isActive(report) && !knownResolvedIds.current.has(report.id));
    setReports(active);
    setLastSelected((previous) => next.find((report) => report.id === previous?.id && report.resolvedAt) ?? previous);
    setDuplicateCandidates((previous) => previous
      ?.filter((candidate) => !knownResolvedIds.current.has(candidate.id))
      .map((candidate) => next.find((report) => report.id === candidate.id) ?? candidate) ?? null);
  }

  useEffect(() => {
    let active = true;
    let events: EventSource | null = null;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let heartbeat: number | undefined;
    let reconnects = 0;
    setLoading(true);
    setLoadError("");
    setConnection("connecting");
    function receiveSnapshot(value: string) {
      if (!active || value === "pong") return;
      try {
        const data = JSON.parse(value) as { reports?: Report[] };
        if (Array.isArray(data.reports)) {
          receiveReports(data.reports);
          setConnection("live");
        }
      } catch {
        setConnection("offline");
      }
    }
    function connectWebSocket() {
      if (!active) return;
      const url = new URL("/api/events", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(url);
      socket = current;
      current.onopen = () => {
        if (!active || socket !== current) return;
        reconnects = 0;
        setConnection("live");
        window.clearInterval(heartbeat);
        heartbeat = window.setInterval(() => {
          if (current.readyState === WebSocket.OPEN) current.send("ping");
        }, 25000);
      };
      current.onmessage = (event) => {
        if (socket === current && typeof event.data === "string")
          receiveSnapshot(event.data);
      };
      current.onerror = () => {
        if (active && socket === current) setConnection("offline");
      };
      current.onclose = () => {
        window.clearInterval(heartbeat);
        if (!active || socket !== current) return;
        setConnection("offline");
        reconnectTimer = window.setTimeout(
          connectWebSocket,
          Math.min(1000 * 2 ** reconnects++, 10000),
        );
      };
    }
    async function connect() {
      try {
        const requestRevision = reportsRevision.current;
        const initial = await api<{ reports: Report[] }>("/api/reports");
        if (!active) return;
        if (requestRevision === reportsRevision.current) receiveReports(initial.reports);
        setLoading(false);
        const health = await api<{ realtime: "sse" | "websocket" }>(
          "/api/health",
        );
        if (!active) return;
        if (health.realtime === "websocket") {
          connectWebSocket();
          return;
        }
        events = new EventSource("/api/events", { withCredentials: true });
        events.onopen = () => {
          if (active) setConnection("live");
        };
        events.onerror = () => {
          if (active) setConnection("offline");
        };
        events.addEventListener("reports", (event) => {
          receiveSnapshot((event as MessageEvent).data);
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
      window.clearTimeout(reconnectTimer);
      window.clearInterval(heartbeat);
      socket?.close();
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

  const activeReports = reports.filter((report) => isActive(report) && !knownResolvedIds.current.has(report.id));
  const hasExamples = reports.some((report) => report.source === "demo");
  const baseReports = activeReports.filter(
    (report) => showDemo || report.source !== "demo",
  );
  const distanceFromNearby = (report: Report) => nearby
    ? distanceMeters(nearby.position.latitude, nearby.position.longitude, report.latitude, report.longitude)
    : 0;
  const nearbyReports = nearby
    ? baseReports.filter((report) => distanceFromNearby(report) <= nearbyRadius * 1000)
    : baseReports;
  const filtered = nearbyReports.filter((report) => {
    const matchesCategory = category === "all" || report.category === category;
    const text = searchable(
      `${report.location} ${report.description} ${CATEGORIES[report.category].label}`,
    );
    return matchesCategory && text.includes(searchable(query.trim()));
  });
  const visible = filtered
    .filter(
      (report) =>
        nearby ||
        query.trim() ||
        !bounds ||
        (report.latitude <= bounds.north &&
          report.latitude >= bounds.south &&
          report.longitude <= bounds.east &&
          report.longitude >= bounds.west),
    )
    .sort((a, b) =>
      sort === "distance" && nearby
        ? distanceFromNearby(a) - distanceFromNearby(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : sort === "confirmed"
        ? b.confirmations - a.confirmations ||
          Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const selected = activeReports.find((report) => report.id === selectedId);
  const selectedHistory = selected ?? (lastSelected?.id === selectedId ? lastSelected : null);
  useEffect(() => {
    if (selected) setLastSelected(selected);
  }, [selected]);
  const communityCount = activeReports.filter(
    (report) => report.source === "community",
  ).length;

  function focusReport(report: Report, open = true) {
    setSelectedId(report.id);
    setLastSelected(report);
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
    setPicking(false);
    setDialog("new");
  }
  function disableNearby() {
    nearbyRequest.current += 1;
    setNearby(null);
    setNearbyPending(false);
    setNearbyError("");
    setSort((previous) => previous === "distance" ? "recent" : previous);
  }
  function prepareReportFocus(report: Report) {
    // A pending location request must not hide this point after publication.
    nearbyRequest.current += 1;
    setNearbyPending(false);
    const { area, radius } = nearbyCurrent.current;
    const outside = Boolean(area && distanceMeters(
      area.position.latitude, area.position.longitude, report.latitude, report.longitude,
    ) > radius * 1000);
    if (outside) disableNearby();
    return outside;
  }
  function findNearby() {
    const request = ++nearbyRequest.current;
    setNearbyError("");
    if (!navigator.geolocation) {
      setNearby(null);
      setNearbyPending(false);
      setSort((previous) => previous === "distance" ? "recent" : previous);
      setNearbyError("Questo browser non supporta la posizione. Vicino a me non è attivo: puoi esplorare la mappa.");
      return;
    }
    setNearbyPending(true);
    navigator.geolocation.getCurrentPosition((position) => {
      if (nearbyRequest.current !== request) return;
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setNearby({ position: point, updatedAt: Date.now() });
      setNearbyPending(false);
      setSort("distance");
      setTarget({ ...point, radiusMeters: nearbyRadius * 1000, key: Date.now() });
    }, (error) => {
      if (nearbyRequest.current !== request) return;
      setNearby(null);
      setNearbyPending(false);
      setSort((previous) => previous === "distance" ? "recent" : previous);
      setNearbyError(error.code === 1
        ? "Posizione non autorizzata. Vicino a me non è attivo: puoi consentire la posizione nel browser oppure esplorare la mappa."
        : error.code === 3
          ? "La ricerca della posizione ha impiegato troppo tempo. Vicino a me non è attivo: riprova o esplora la mappa."
          : "Posizione non disponibile. Vicino a me non è attivo: riprova o esplora la mappa.");
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 0 });
  }
  function changeNearbyRadius(radius: NearbyRadius) {
    setNearbyRadius(radius);
    if (nearby) setTarget({ ...nearby.position, radiusMeters: radius * 1000, key: Date.now() });
  }
  function getPosition(forReport = false) {
    if (!navigator.geolocation) {
      const message = "Questo browser non supporta la posizione. Scegli un punto sulla mappa.";
      if (forReport) setFormError(message);
      else setToast(message);
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
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }
  function applyMutation(report: Report, requestRevision: number, allowAdd = false) {
    if (report.resolvedAt) {
      knownResolvedIds.current.add(report.id);
      setDuplicateCandidates((previous) => previous?.filter((candidate) => !knownResolvedIds.current.has(candidate.id)) ?? null);
    } else if (knownResolvedIds.current.has(report.id)) {
      // A delayed active response cannot undo an explicitly observed resolution.
      return;
    }
    if (!isActive(report)) {
      reportsRevision.current += 1;
      setReports((previous) => previous.filter((item) => item.id !== report.id));
      setLastSelected((previous) => previous?.id === report.id ? report : previous);
    } else if (reportsRevision.current === requestRevision) {
      // A later realtime snapshot is authoritative: an older response must not
      // restore a report that the community has already removed.
      reportsRevision.current += 1;
      setReports((previous) => {
        const exists = previous.some((item) => item.id === report.id);
        if (!exists && !allowAdd) return previous;
        return exists
          ? previous.map((item) => item.id === report.id ? report : item)
          : [report, ...previous];
      });
    }
  }

  async function publishReport(allowDuplicate = false) {
    if (submitInFlight.current || voteInFlight.current) return;
    if (allowDuplicate && duplicateRequestKey.current !== draftKey) {
      setDuplicateCandidates(null);
      setFormError("La bozza è cambiata. Ricontrolla la segnalazione prima di pubblicare.");
      return;
    }
    if (!draft.position) {
      setFormError("Scegli la posizione del pericolo sulla mappa o usa la tua posizione.");
      return;
    }
    if (draft.location.trim().length < 3) {
      setFormError("Indica la strada o un punto di riferimento (almeno 3 caratteri).");
      return;
    }
    if (draft.description.trim().length < 10) {
      setFormError("Descrivi il pericolo con almeno 10 caratteri.");
      return;
    }
    submitInFlight.current = true;
    setSending(true);
    setFormError("");
    const requestRevision = reportsRevision.current;
    const requestKey = draftKey;
    try {
      const body: NewReport = {
        category: draft.category,
        severity: draft.severity,
        location: draft.location.trim(),
        description: draft.description.trim(),
        ...draft.position,
        ...(allowDuplicate ? { allowDuplicate: true } : {}),
      };
      const { report } = await api<{ report: Report }>("/api/reports", body);
      applyMutation(report, requestRevision, true);
      const outsideNearby = prepareReportFocus(report);
      setCategory("all");
      setQuery("");
      setMobileView("map");
      setSelectedId(report.id);
      setLastSelected(report);
      setTarget({ latitude: report.latitude, longitude: report.longitude, zoom: 14, key: Date.now() });
      setDialog(null);
      setDraft({ ...EMPTY_DRAFT });
      setDuplicateCandidates(null);
      setToast(outsideNearby ? "Segnalazione pubblicata. Vicino a me è stato disattivato per mostrarti il punto." : "Segnalazione pubblicata. Grazie per il tuo contributo!");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "POSSIBLE_DUPLICATE") {
        if (latestDraftKey.current !== requestKey) {
          setFormError("La bozza è cambiata. Premi di nuovo Pubblica per ricontrollarla.");
          return;
        }
        duplicateRequestKey.current = requestKey;
        for (const report of error.duplicates ?? []) {
          if (report.resolvedAt) knownResolvedIds.current.add(report.id);
        }
        setDuplicateCandidates((error.duplicates ?? []).filter((report) => report.source === "community" && isActive(report) && !knownResolvedIds.current.has(report.id)));
        setDuplicateUnavailable([]);
          } else {
        setFormError(error instanceof Error ? error.message : "Invio non riuscito. Riprova.");
      }
    } finally {
      submitInFlight.current = false;
      setSending(false);
    }
  }

  function submitReport(event: FormEvent) {
    event.preventDefault();
    // Overriding a duplicate always requires the explicit dedicated button.
    if (duplicateCandidates !== null) return;
    void publishReport();
  }

  async function voteReport(report: Report, action: "confirm" | "clear", fromDuplicate = false) {
    if (voteInFlight.current || submitInFlight.current) return;
    if ((action === "confirm" && report.confirmedByMe) || (action === "clear" && report.clearedByMe)) return;
    voteInFlight.current = true;
    setVoting({ id: report.id, action });
    if (fromDuplicate) setFormError("");
    else setConfirmError("");
    const requestRevision = reportsRevision.current;
    try {
      const { report: updated } = await api<{ report: Report }>(`/api/reports/${encodeURIComponent(report.id)}/${action}`, {});
      applyMutation(updated, requestRevision);
      setDuplicateCandidates((previous) => previous
        ?.filter((candidate) => !knownResolvedIds.current.has(candidate.id))
        .map((candidate) => candidate.id === updated.id ? updated : candidate) ?? null);
      if (fromDuplicate) {
        const outsideNearby = prepareReportFocus(updated);
        setDialog(null);
        setDraft({ ...EMPTY_DRAFT });
        setDuplicateCandidates(null);
        setFormError("");
        setCategory("all");
        setQuery("");
        setMobileView("map");
        setSelectedId(updated.id);
        setLastSelected(updated);
        setTarget({ latitude: updated.latitude, longitude: updated.longitude, zoom: 14, key: Date.now() });
        setToast(outsideNearby ? "Segnalazione esistente confermata. Vicino a me è stato disattivato per mostrarti il punto." : "Segnalazione esistente confermata. Nessun duplicato pubblicato.");
      } else if (action === "clear") {
        setToast(updated.resolvedAt
          ? "Raggiunti i voti necessari: la segnalazione è stata rimossa dalla mappa."
          : `Voto registrato: ${updated.clearVotes}/${CLEAR_VOTE_THRESHOLD} indicazioni di pericolo non più presente.`);
      } else {
        setToast("Presenza confermata. Il tuo eventuale voto di rimozione è stato sostituito.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voto non riuscito. Riprova.";
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
        reportsRevision.current += 1;
        setReports((previous) => previous.filter((item) => item.id !== report.id));
        setDuplicateUnavailable((previous) => [...new Set([...previous, report.id])]);
      }
      if (fromDuplicate) setFormError(message);
      else setConfirmError(message);
    } finally {
      voteInFlight.current = false;
      setVoting(null);
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
              className={`location-button ${nearby ? "is-active" : ""}`}
              aria-label={nearby ? "Aggiorna Vicino a me" : "Vicino a me"}
              title="Vicino a me"
              aria-pressed={Boolean(nearby)}
              aria-busy={nearbyPending}
              onClick={findNearby}
              disabled={nearbyPending}
            >
              {nearbyPending ? (
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

          {(nearby || nearbyPending) && <div className="nearby-controls" aria-label="Filtro Vicino a me">
            <div className="nearby-status" role="status"><LocateFixed size={18} /><div><strong>{nearbyPending ? "Ricerca della posizione…" : `Vicino a me · entro ${nearbyRadius} km`}</strong><span>{nearby ? `Posizione rilevata alle ${new Date(nearby.updatedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}. Nessun tracciamento continuo.` : "La posizione viene richiesta solo per questa ricerca."}</span></div></div>
            <div className="nearby-actions">
              <label>Raggio<select aria-label="Raggio Vicino a me" value={nearbyRadius} disabled={nearbyPending} onChange={(event) => changeNearbyRadius(Number(event.target.value) as NearbyRadius)}><option value={5}>5 km</option><option value={10}>10 km</option><option value={25}>25 km</option></select></label>
              {nearby && <button type="button" className="nearby-refresh" onClick={findNearby} disabled={nearbyPending}><LocateFixed size={15} />Aggiorna posizione</button>}
              <button type="button" className="nearby-disable" onClick={disableNearby}><X size={15} />{nearby ? "Disattiva Vicino a me" : "Annulla ricerca"}</button>
            </div>
            <p className="nearby-scope">Il filtro usa le segnalazioni già caricate, al massimo le 500 più recenti. Il filtro è calcolato sul telefono: non inviamo le coordinate al server dell’app per questa ricerca.</p>
          </div>}
          {nearbyError && <div className="nearby-error" role="alert"><LocateFixed size={17} /><span>{nearbyError}</span><button type="button" onClick={findNearby}>Riprova Vicino a me</button></div>}

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
                Tutte<span className="filter-count">{nearbyReports.length}</span>
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
                nearby={nearby ? { ...nearby.position, radiusMeters: nearbyRadius * 1000 } : null}
              />
              <div className="map-area-label">
                <span className="map-area-icon">
                  <MapPin size={16} />
                </span>
                <div>
                  <strong>{nearby ? `Vicino a me · ${nearbyRadius} km` : "Esplora la tua prossima strada"}</strong>
                  <span>{nearby ? "La lista resta nel raggio della posizione rilevata" : "Sposta la mappa per scoprire le segnalazioni"}</span>
                </div>
              </div>
              <button
                className="map-reset icon-button"
                title={nearby ? "Centra l’area Vicino a me" : "Torna al Lago di Garda"}
                aria-label={nearby ? "Centra l’area Vicino a me" : "Torna al Lago di Garda"}
                onClick={() =>
                  setTarget(nearby ? {
                    ...nearby.position,
                    radiusMeters: nearbyRadius * 1000,
                    key: Date.now(),
                  } : {
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
                      : nearby ? `ENTRO ${nearbyRadius} KM DA TE` : "AREA VISUALIZZATA"}
                  </span>
                  <h2>
                    {nearby ? "Segnalazioni vicine" : "Segnalazioni in zona"} <span>{visible.length}</span>
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
                    {nearby && <option value="distance">Più vicine</option>}
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
                        : nearby ? `Nessuna segnalazione caricata entro ${nearbyRadius} km con questi filtri. Puoi aumentare il raggio o aggiornare la posizione.` : "Non ci sono segnalazioni con questi filtri. Esplora la mappa o aggiungi il tuo contributo."}
                    </p>
                    {nearby && <div className="nearby-empty-actions"><button type="button" className="text-button" onClick={findNearby} disabled={nearbyPending}>Aggiorna posizione</button><button type="button" className="text-button" onClick={disableNearby}>Disattiva Vicino a me</button></div>}
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
                    {nearby && <span className="card-distance"><Navigation size={13} />{formatDistance(distanceFromNearby(report))} in linea d’aria</span>}
                    {report.clearVotes > 0 && <span className="card-clear-votes">Verifica rimozione: {report.clearVotes}/{CLEAR_VOTE_THRESHOLD}</span>}
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
                {!hasExamples
                  ? "Fino a 24 ore · autovelox mobili 1 ora."
                  : showDemo
                    ? "Le segnalazioni “ESEMPIO” sono dimostrative."
                    : "Stai visualizzando solo le segnalazioni della community."}
              </span>
              {hasExamples && (
                <button onClick={() => setShowDemo((value) => !value)}>
                  {showDemo ? "Nascondi esempi" : "Mostra esempi"}
                </button>
              )}
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

      {toast && dialog !== "new" && (
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
            if (!sending && !voting) setDialog(null);
          }}
          className="new-report-dialog"
        >
          <form onSubmit={submitReport} noValidate>
            <div className="dialog-content report-form">
              <p className="dialog-intro">
                Un'informazione utile a chi percorrerà la tua stessa strada.
              </p>
              {duplicateCandidates !== null ? (
                <section className="duplicate-panel" aria-labelledby="duplicate-title">
                  <div className="duplicate-heading"><Layers size={23} /><div>
                    <h3 id="duplicate-title">Qualcuno lo ha già segnalato?</h3>
                    <p>Ci sono segnalazioni dello stesso tipo entro {DUPLICATE_RADIUS_METERS} metri. Se è lo stesso pericolo, confermalo; se è un altro, puoi pubblicarlo comunque.</p>
                  </div></div>
                  <div className="duplicate-list">
                    {duplicateCandidates.map((candidate) => {
                      const unavailable = !isActive(candidate) || duplicateUnavailable.includes(candidate.id);
                      const pending = voting?.id === candidate.id;
                      const confirmed = candidate.confirmedByMe;
                      return <article className={`duplicate-card ${unavailable ? "duplicate-card--inactive" : ""}`} key={candidate.id} aria-label={`Possibile duplicato: ${candidate.location}`}>
                        <div className="duplicate-card-heading"><CategoryIcon category={candidate.category} /><div><strong>{candidate.location}</strong><span>{draft.position ? `${Math.round(distanceMeters(draft.position.latitude, draft.position.longitude, candidate.latitude, candidate.longitude))} m dal punto scelto · ` : ""}{ago(candidate.createdAt)}</span></div></div>
                        <p>{candidate.description}</p>
                        <span className="duplicate-confirmations"><ShieldCheck size={14} />{candidate.confirmations} conferme di presenza</span>
                        {unavailable ? <div className="duplicate-result" role="status">Non è più attiva: potrebbe essere risolta o scaduta. La tua bozza è conservata.</div> : <>
                          <button type="button" className={`duplicate-confirm-button ${confirmed ? "is-confirmed" : ""}`} disabled={sending || Boolean(voting) || confirmed} onClick={() => void voteReport(candidate, "confirm", true)}>
                            {pending ? <LoaderCircle className="spin" size={17} /> : confirmed ? <CheckCheck size={17} /> : <ThumbsUp size={17} />}
                            {pending ? "Conferma in corso…" : confirmed ? "Hai confermato questa segnalazione" : "Conferma questa segnalazione"}
                          </button>
                        </>}
                      </article>;
                    })}
                    {duplicateCandidates.length === 0 && <p className="duplicate-result">I suggerimenti non sono più disponibili. Puoi tornare alla bozza e ricontrollare prima di pubblicare.</p>}
                  </div>
                  <p className="duplicate-draft-note"><ShieldCheck size={15} />La tua bozza resta salvata in questa schermata, anche se una conferma non riesce.</p>
                </section>
              ) : (<>
              <fieldset disabled={sending || Boolean(voting)}>
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
              <fieldset disabled={sending || Boolean(voting)}>
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
              <fieldset disabled={sending || Boolean(voting)}>
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
              </>)}
              {formError && (
                <div className="form-error" role="alert">
                  <TriangleAlert size={17} />
                  {formError}
                </div>
              )}
              <p className="form-privacy">
                <ShieldCheck size={14} />
                Condividiamo solo il punto scelto, non i tuoi spostamenti. Questa
                segnalazione scade dopo {reportDuration(draft.category)}; le conferme non ne prolungano la durata.
              </p>
            </div>
            <div className={`dialog-footer ${duplicateCandidates !== null ? "duplicate-footer" : ""}`}>
              {duplicateCandidates !== null ? <>
                <button className="text-button" type="button" disabled={sending || Boolean(voting)} onClick={() => { setDuplicateCandidates(null); setFormError(""); }}>Torna a modificare la bozza</button>
                <button className="primary-button duplicate-force-button" type="button" disabled={sending || Boolean(voting) || locating} onClick={() => void publishReport(true)}>
                  {sending ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                  {sending ? "Pubblicazione…" : "È un altro pericolo: pubblica comunque"}
                </button>
              </> : <>
                <span>Segnala solo dopo esserti fermato.</span>
                <button className="primary-button" type="submit" disabled={sending || Boolean(voting) || locating}>
                  {sending ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                  {sending ? "Pubblicazione…" : "Pubblica segnalazione"}
                </button>
              </>}
            </div>
          </form>
        </Dialog>
      )}

      {dialog === "detail" && (
        <Dialog title={selected && isActive(selected) ? CATEGORIES[selected.category].singular : "Segnalazione non più attiva"} onClose={() => setDialog(null)} className="detail-dialog">
          {selected && isActive(selected) ? <>
            <div className="dialog-content">
              <div className="detail-category">
                <CategoryIcon category={selected.category} size={27} />
                <span className={`severity-badge ${selected.severity === "danger" ? "is-danger" : ""}`}><span />{selected.severity === "danger" ? "Pericolo elevato" : "Attenzione"}</span>
                <span className="detail-age">{ago(selected.createdAt)}</span>
              </div>
              <h3 className="detail-location">{selected.location}</h3>
              <p className="detail-description">{selected.description}</p>
              {selected.source === "demo" && <div className="demo-detail"><Sparkles size={18} /><div><strong>Segnalazione di esempio</strong><p>Serve a esplorare Passo e non descrive le condizioni reali della strada.</p></div></div>}
              <div className="detail-facts">
                <div><MapPin size={17} /><span>Punto segnalato<strong>{selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}</strong></span></div>
                <div><ShieldCheck size={17} /><span>Presenza segnalata dalla community<strong>{selected.confirmations} {selected.confirmations === 1 ? "conferma" : "conferme"}{selected.confirmedByMe ? ", inclusa la tua" : ""}</strong></span></div>
                <div><Radio size={17} /><span>Visibile fino alle<strong>{new Date(selected.expiresAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} del {new Date(selected.expiresAt).toLocaleDateString("it-IT", { day: "numeric", month: "long" })}</strong></span></div>
              </div>
              <div className="confirm-explainer">
                <h4>Che cosa hai trovato passando di qui?</h4>
                <p>Indica solo ciò che hai osservato. Puoi cambiare voto: la nuova osservazione sostituisce quella precedente.</p>
              </div>
              <div className={`clear-progress ${selected.clearedByMe ? "clear-progress--voted" : ""}`} role="status">
                <div><CheckCheck size={17} /><span>Non più presente</span><strong>{selected.clearVotes}/{CLEAR_VOTE_THRESHOLD} voti</strong></div>
                <progress value={selected.clearVotes} max={CLEAR_VOTE_THRESHOLD} aria-label={`Voti di rimozione: ${selected.clearVotes} su ${CLEAR_VOTE_THRESHOLD}`} />
                <p>La segnalazione scompare dopo {CLEAR_VOTE_THRESHOLD} voti di browser diversi. {selected.clearedByMe ? "Il tuo voto è incluso." : "Nel frattempo resta visibile."}</p>
              </div>
              {confirmError && <div className="form-error" role="alert"><TriangleAlert size={17} />{confirmError}</div>}
            </div>
            <div className="dialog-footer detail-footer detail-vote-footer">
              <span><ShieldCheck size={15} />Un'osservazione per browser. Puoi cambiarla.</span>
              <div className="report-vote-actions">
                <button className={`clear-vote-button ${selected.clearedByMe ? "is-voted" : ""}`} onClick={() => void voteReport(selected, "clear")} disabled={selected.clearedByMe || Boolean(voting)} aria-pressed={selected.clearedByMe}>
                  {voting?.id === selected.id && voting.action === "clear" ? <LoaderCircle className="spin" size={17} /> : <CheckCheck size={17} />}
                  {voting?.id === selected.id && voting.action === "clear" ? "Invio del voto…" : "Non è più presente"}
                </button>
                <button className={`primary-button ${selected.confirmedByMe ? "confirmed-button" : ""}`} onClick={() => void voteReport(selected, "confirm")} disabled={selected.confirmedByMe || Boolean(voting)} aria-pressed={selected.confirmedByMe}>
                  {voting?.id === selected.id && voting.action === "confirm" ? <LoaderCircle className="spin" size={17} /> : selected.confirmedByMe ? <CheckCheck size={17} /> : <ThumbsUp size={17} />}
                  {selected.confirmedByMe ? "Hai confermato" : voting?.id === selected.id && voting.action === "confirm" ? "Conferma in corso…" : "Confermo, è presente"}
                </button>
              </div>
            </div>
          </> : <div className="dialog-content empty-state inactive-report-state" role="status">
            {selectedHistory?.resolvedAt ? <CheckCheck size={32} /> : <CircleHelp size={32} />}
            <h3>{selectedHistory?.resolvedAt ? "La community ha indicato che non è più presente." : selectedHistory && new Date(selectedHistory.expiresAt).getTime() <= Date.now() ? "Questa segnalazione è scaduta." : "Questa segnalazione non è più attiva."}</h3>
            <p>{selectedHistory?.resolvedAt ? `Sono stati raggiunti ${CLEAR_VOTE_THRESHOLD} voti di rimozione: il punto è stato tolto dalla mappa.` : `Potrebbe essere stata risolta dalla community o essere scaduta. La durata massima è ${selectedHistory ? reportDuration(selectedHistory.category) : "24 ore; per gli autovelox mobili è 1 ora"}.`}</p>
            {confirmError && <div className="form-error" role="alert"><TriangleAlert size={17} />{confirmError}</div>}
            <button className="primary-button" onClick={openNew}><Plus size={17} />Nuova segnalazione</button>
          </div>}
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
                  descrivilo. Se c'è una segnalazione simile entro {DUPLICATE_RADIUS_METERS} metri,
                  puoi confermarla oppure indicare che si tratta di un altro pericolo.
                </p>
              </div>
            </div>
            <div className="info-step">
              <span>02</span>
              <div>
                <h3>Conferma quello che hai visto.</h3>
                <p>
                  Se un pericolo è ancora presente, confermalo. Se non c'è più,
                  indicalo: dopo {CLEAR_VOTE_THRESHOLD} voti di browser diversi scompare dalla mappa.
                  Puoi cambiare osservazione; ogni browser esprime un solo voto alla volta.
                </p>
              </div>
            </div>
            <div className="info-step">
              <span>03</span>
              <div>
                <h3>Controlla quando è stato segnalato.</h3>
                <p>
                  Gli autovelox mobili scadono dopo 1 ora; le altre segnalazioni
                  dopo 24 ore. Le conferme non ne prolungano la durata. Quelle contrassegnate “ESEMPIO” sono
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
              quando premi “Vicino a me”, “Aggiorna posizione” o “La mia posizione”, con il tuo
              consenso nel browser. Vicino a me calcola nel browser distanze e raggio di 5, 10 o 25 km
              sulle segnalazioni caricate; le coordinate del filtro non vengono inviate al server dell’app per questa ricerca.
              La posizione non si aggiorna mentre ti sposti: premi “Aggiorna posizione” quando serve.
            </p>
            <h3>Cosa viene condiviso</h3>
            <p>
              Quando pubblichi, il punto che hai scelto, il tipo di pericolo e
              la descrizione diventano visibili agli altri. Non inserire nomi,
              numeri di telefono o altri dati personali nella descrizione.
              Gli autovelox mobili restano visibili fino a 1 ora, le altre segnalazioni fino a 24 ore;
              le conferme non rinnovano la durata.
            </p>
            <h3>Conferme e memoria del browser</h3>
            <p>
              Un cookie tecnico anonimo permette di riconoscere il tuo voto di
              presenza o rimozione e di sostituirlo quando cambi osservazione. Non è un account
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
