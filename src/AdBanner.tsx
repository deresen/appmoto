import { useEffect, useRef, useSyncExternalStore } from "react";
import { Info } from "lucide-react";
import { isPublisherArticlePath, type AdPlacement } from "../shared/advertising";
import {
  getAdvertisingState,
  initializeAdvertising,
  openAdvertisingChoices,
  requestAdvertisingUnit,
  subscribeAdvertising,
} from "./adSense";
import "./ad-banner.css";

function AdvertisingUnit({ placement }: { placement: AdPlacement }) {
  const state = useSyncExternalStore(subscribeAdvertising, getAdvertisingState, getAdvertisingState);
  const ref = useRef<HTMLModElement>(null);
  useEffect(() => {
    if (ref.current) void requestAdvertisingUnit(ref.current, placement);
  }, [placement, state.consentEpoch]);
  return <ins ref={ref} className="adsbygoogle passo-ad-unit"
    data-ad-client={state.config.clientId} data-ad-slot={state.config.slots[placement]}
    data-ad-format="horizontal" data-full-width-responsive="true" />;
}

export default function AdBanner({ placement }: { placement: AdPlacement }) {
  const state = useSyncExternalStore(subscribeAdvertising, getAdvertisingState, getAdvertisingState);
  useEffect(() => { void initializeAdvertising(); }, []);
  if (!isPublisherArticlePath(window.location.pathname)) return null;
  const active = state.status === "consented" && Boolean(state.config.slots[placement]);
  return <aside className={`advertising-banner ${active ? "advertising-banner--active" : ""}`}
    aria-label="Spazio pubblicitario" data-ad-placement={placement}>
    <div className="advertising-caption"><span>Pubblicità</span><AdvertisingPreferencesButton /></div>
    <div className="advertising-content">
      {active ? <AdvertisingUnit key={state.consentEpoch} placement={placement} /> : <div className="advertising-placeholder">
        <Info size={17} strokeWidth={1.5} aria-hidden="true" /><span>Spazio pubblicitario</span>
      </div>}
    </div>
  </aside>;
}

export function AdvertisingPreferencesButton() {
  const state = useSyncExternalStore(subscribeAdvertising, getAdvertisingState, getAdvertisingState);
  if (!state.choicesAvailable) return null;
  return <button type="button" className="advertising-preferences" onClick={() => { openAdvertisingChoices(); }}>
    Preferenze pubblicità
  </button>;
}
