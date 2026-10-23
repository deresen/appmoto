import {
  hasAdvertisingConsent,
  isAdvertisingConfigured,
  parseAdvertisingConfig,
  type AdvertisingConfig,
  type AdPlacement,
  type TcfConsentData,
} from "../shared/advertising";

type TcfCallback = (data: TcfConsentData, success: boolean) => void;
interface GoogleFundingChoices {
  callbackQueue?: Array<{ CONSENT_API_READY: () => void }>;
  showRevocationMessage?: () => void;
}
declare global {
  interface Window {
    __tcfapi?: (command: string, version: number, callback: TcfCallback) => void;
    googlefc?: GoogleFundingChoices;
    adsbygoogle?: { push: (parameters: Record<string, unknown>) => unknown };
  }
}

type AdvertisingStatus = "inactive" | "waiting" | "consented" | "declined" | "unavailable";
export interface AdvertisingState {
  status: AdvertisingStatus;
  config: AdvertisingConfig;
  consentEpoch: number;
  choicesAvailable: boolean;
}
let state: AdvertisingState = {
  status: "inactive", config: parseAdvertisingConfig({}), consentEpoch: 0, choicesAvailable: false,
};
const subscribers = new Set<() => void>();
const scripts = new Map<string, Promise<void>>();
const requestedUnits = new WeakSet<HTMLElement>();
let initialization: Promise<void> | undefined;

function update(next: Partial<AdvertisingState>) {
  if (Object.entries(next).every(([key, value]) => state[key as keyof AdvertisingState] === value)) return;
  const consentChanged = next.status !== undefined
    && (next.status === "consented") !== (state.status === "consented");
  state = { ...state, ...next, consentEpoch: state.consentEpoch + (consentChanged ? 1 : 0) };
  for (const subscriber of subscribers) subscriber();
}

export const getAdvertisingState = () => state;
export function subscribeAdvertising(subscriber: () => void) {
  subscribers.add(subscriber);
  return () => { subscribers.delete(subscriber); };
}

function loadScript(id: string, source: string, crossOrigin = false): Promise<void> {
  const existing = scripts.get(id);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    // Only this module creates these IDs. An unrelated script is never trusted.
    if (document.getElementById(id)) {
      reject(new Error("Advertising script already present outside the loader."));
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.async = true;
    script.src = source;
    if (crossOrigin) script.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error("Advertising script timed out."));
    }, 15000);
    script.onload = () => { window.clearTimeout(timer); resolve(); };
    script.onerror = () => { window.clearTimeout(timer); script.remove(); reject(new Error("Advertising script unavailable.")); };
    document.head.appendChild(script);
  });
  scripts.set(id, promise);
  return promise;
}

function watchGoogleChoices() {
  const fundingChoices = window.googlefc ||= {};
  const ready = () => update({ choicesAvailable: typeof window.googlefc?.showRevocationMessage === "function" });
  (fundingChoices.callbackQueue ||= []).push({ CONSENT_API_READY: ready });
  ready();
}

async function listenForConsent() {
  const deadline = Date.now() + 10000;
  while (typeof window.__tcfapi !== "function" && Date.now() < deadline) {
    await new Promise<void>(resolve => window.setTimeout(resolve, 200));
  }
  if (typeof window.__tcfapi !== "function") { update({ status: "unavailable" }); return; }
  window.__tcfapi("addEventListener", 2, (data, success) => {
    if (!success) { update({ status: "unavailable" }); return; }
    if (hasAdvertisingConsent(data)) update({ status: "consented" });
    else if (data?.eventStatus === "cmpuishown" || data?.cmpStatus === "loading") update({ status: "waiting" });
    else update({ status: "declined" });
    update({ choicesAvailable: typeof window.googlefc?.showRevocationMessage === "function" });
  });
}

/** Fetching local configuration never starts an advertising or CMP request by itself. */
export function initializeAdvertising(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const response = await fetch("/ads-config.json", { credentials: "omit", cache: "no-store" });
      if (!response.ok) return;
      const config = parseAdvertisingConfig(await response.json());
      update({ config });
      if (!isAdvertisingConfigured(config)) return;
      update({ status: "waiting" });
      watchGoogleChoices();
      await loadScript("passo-google-cmp", config.cmpScriptUrl);
      watchGoogleChoices();
      await listenForConsent();
    } catch { update({ status: "unavailable" }); }
  })();
  return initialization;
}

export async function requestAdvertisingUnit(element: HTMLElement, placement: AdPlacement): Promise<void> {
  const { config, consentEpoch } = state;
  if (state.status !== "consented" || !isAdvertisingConfigured(config) || !config.slots[placement]
    || !element.isConnected || requestedUnits.has(element)) return;
  try {
    await loadScript("passo-google-adsense", `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${config.clientId}`, true);
    if (state.status !== "consented" || state.consentEpoch !== consentEpoch
      || !element.isConnected || requestedUnits.has(element)) return;
    requestedUnits.add(element);
    (window.adsbygoogle ||= [] as Array<Record<string, unknown>>).push({});
  } catch { update({ status: "unavailable" }); }
}

export function openAdvertisingChoices(): boolean {
  const show = window.googlefc?.showRevocationMessage;
  if (typeof show !== "function") return false;
  try { show.call(window.googlefc); return true; }
  catch { return false; }
}
