import { useEffect, useRef, useState } from "react";
import { divIcon, DomEvent, latLng, type TileLayer as LeafletTileLayer } from "leaflet";
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { Category, Report } from "./types";

type Position = { latitude: number; longitude: number };
type Bounds = { north: number; south: number; east: number; west: number };
type MapTarget = Position & { zoom?: number; radiusMeters?: number; key: number };

type MapViewProps = {
  reports: Report[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  target: MapTarget | null;
  picking: boolean;
  pickedPosition: Position | null;
  onPick: (position: Position) => void;
  onBoundsChange: (bounds: Bounds) => void;
  onMapReady?: () => void;
  nearby?: (Position & { radiusMeters: number }) | null;
};

const categoryNames: Record<Category, string> = {
  pothole: "Buca",
  rough_road: "Strada dissestata",
  gravel: "Ghiaia",
  dirt: "Terra sulla strada",
  mud: "Fango sulla strada",
  oil: "Olio",
  obstacle: "Ostacolo",
  closure: "Chiusura",
  mobile_speed_camera: "Autovelox mobile",
  other: "Altro pericolo",
};

const categoryPaths: Record<Category, string> = {
  pothole: '<path d="M4 5v14m16-14v14M9 3v4m6 10v4M8 13l3-3 3 4 3-3"/>',
  rough_road: '<path d="M3 5h18M3 19h18M3 13l4-3 4 5 4-5 3 3 3-1"/>',
  gravel:
    '<circle cx="8" cy="8" r="2.5"/><circle cx="16" cy="15" r="3"/><circle cx="6" cy="18" r="1.5"/><path d="m17 5 2 2m-8 12 1 1"/>',
  dirt: '<path d="M3 18h18M4 18l4-7 3 3 3-5 6 9M7 6h.01M17 5h.01"/>',
  mud: '<path d="M4 9a4 4 0 0 1 4-4h1a4 4 0 0 1 7 1h1a3 3 0 0 1 0 6H6M7 14l-1 3m6-2-1 3m6-3-1 3M3 21h18"/>',
  oil: '<path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11Z"/><path d="M9 14a3 3 0 0 0 3 3"/>',
  obstacle: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',
  closure: '<circle cx="12" cy="12" r="9"/><path d="M7 12h10"/>',
  mobile_speed_camera: '<rect x="4" y="5" width="16" height="12" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M9 21h6m-3-4v4M18 2l2 1M5 2 3 3"/>',
  other: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 8v6m0 3v.01"/>',
};

function reportIcon(report: Report, selected: boolean) {
  const classes = [
    "road-marker",
    `road-marker--${report.category}`,
    selected ? "road-marker--selected" : "",
    report.severity === "danger" ? "road-marker--danger" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return divIcon({
    className: "road-marker-shell",
    iconSize: [42, 42],
    iconAnchor: [21, 21],
    html: `<span class="${classes}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${categoryPaths[report.category]}</svg></span>`,
  });
}

const pickedIcon = divIcon({
  className: "picked-marker-shell",
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  html: '<span class="picked-marker"><span></span></span>',
});

function MapBehavior({
  target,
  picking,
  onPick,
  onBoundsChange,
  onMapReady,
}: Pick<
  MapViewProps,
  "target" | "picking" | "onPick" | "onBoundsChange" | "onMapReady"
>) {
  const map = useMap();
  const callbacks = useRef({ picking, onPick, onBoundsChange, onMapReady });
  callbacks.current = { picking, onPick, onBoundsChange, onMapReady };

  useEffect(() => {
    const emitBounds = () => {
      const bounds = map.getBounds();
      callbacks.current.onBoundsChange({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      });
    };
    const choosePosition = (event: {
      latlng: { lat: number; lng: number };
    }) => {
      if (callbacks.current.picking) {
        callbacks.current.onPick({
          latitude: event.latlng.lat,
          longitude: event.latlng.lng,
        });
      }
    };
    const chooseWithKeyboard = (event: { originalEvent: KeyboardEvent }) => {
      if (
        !callbacks.current.picking ||
        !["Enter", " "].includes(event.originalEvent.key)
      )
        return;
      event.originalEvent.preventDefault();
      const center = map.getCenter();
      callbacks.current.onPick({ latitude: center.lat, longitude: center.lng });
    };
    map.on("moveend", emitBounds);
    map.on("click", choosePosition);
    map.on("keydown", chooseWithKeyboard);
    emitBounds();
    callbacks.current.onMapReady?.();
    return () => {
      map.off("moveend", emitBounds);
      map.off("click", choosePosition);
      map.off("keydown", chooseWithKeyboard);
    };
  }, [map]);

  useEffect(() => {
    map.getContainer().style.cursor = picking ? "crosshair" : "";
    map.getContainer().setAttribute("role", "region");
    map
      .getContainer()
      .setAttribute(
        "aria-label",
        picking
          ? "Scegli la posizione: sposta la mappa con le frecce e premi Invio per selezionare il centro."
          : "Mappa delle segnalazioni. Usa le frecce per spostarla e i tasti più e meno per lo zoom.",
      );
  }, [map, picking]);

  useEffect(() => {
    if (target) {
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (target.radiusMeters) {
        map.flyToBounds(latLng(target.latitude, target.longitude).toBounds(target.radiusMeters * 2), {
          padding: [30, 30], maxZoom: 14, animate: !reducedMotion, duration: 0.7,
        });
      } else {
        map.flyTo([target.latitude, target.longitude], target.zoom ?? 14, {
          animate: !reducedMotion,
          duration: 0.7,
        });
      }
    }
  }, [map, target?.key]);

  return null;
}

function MapZoom() {
  const map = useMap();
  const controls = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (controls.current) {
      DomEvent.disableClickPropagation(controls.current);
      DomEvent.disableScrollPropagation(controls.current);
    }
  }, []);

  return (
    <div
      className="map-zoom"
      ref={controls}
      role="group"
      aria-label="Ingrandimento della mappa"
    >
      <button
        className="map-zoom-in"
        type="button"
        title="Zoom avanti"
        aria-label="Zoom avanti"
        onClick={() => map.zoomIn()}
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        className="map-zoom-out"
        type="button"
        title="Zoom indietro"
        aria-label="Zoom indietro"
        onClick={() => map.zoomOut()}
      >
        <span aria-hidden="true">−</span>
      </button>
    </div>
  );
}

export default function MapView(props: MapViewProps) {
  const tiles = useRef<LeafletTileLayer>(null);
  const tileCounts = useRef({ errors: 0, loaded: 0 });
  const [tileWarning, setTileWarning] = useState(false);

  const retryTiles = () => {
    tileCounts.current = { errors: 0, loaded: 0 };
    setTileWarning(false);
    tiles.current?.redraw();
  };

  return (
    <div className="map-view" style={{ height: "100%", position: "relative" }}>
      <MapContainer
        className="road-map"
        center={[45.6, 10.55]}
        zoom={10}
        minZoom={3}
        maxZoom={19}
        zoomControl={false}
        style={{ height: "100%", width: "100%" }}
        attributionControl
      >
        <TileLayer
          ref={tiles}
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
          eventHandlers={{
            tileerror: () => {
              tileCounts.current.errors += 1;
              if (
                tileCounts.current.errors > 3 &&
                tileCounts.current.loaded === 0
              )
                setTileWarning(true);
            },
            tileload: () => {
              tileCounts.current.loaded += 1;
              setTileWarning(false);
            },
          }}
        />
        <MapBehavior
          target={props.target}
          picking={props.picking}
          onPick={props.onPick}
          onBoundsChange={props.onBoundsChange}
          onMapReady={props.onMapReady}
        />
        <MapZoom />
        {props.nearby && <>
          <Circle center={[props.nearby.latitude, props.nearby.longitude]} radius={props.nearby.radiusMeters} pathOptions={{ color: "#427c9a", weight: 1.5, fillColor: "#74aec4", fillOpacity: 0.07, dashArray: "5 5" }} interactive={false} />
          <CircleMarker center={[props.nearby.latitude, props.nearby.longitude]} radius={7} pathOptions={{ color: "#fff", weight: 3, fillColor: "#327da3", fillOpacity: 1 }}>
            <Tooltip>Posizione usata per Vicino a me</Tooltip>
          </CircleMarker>
        </>}
        {props.reports.map((report) => (
          <Marker
            key={report.id}
            position={[report.latitude, report.longitude]}
            icon={reportIcon(report, props.selectedId === report.id)}
            title={`${categoryNames[report.category]} — ${report.location}${report.source === "demo" ? " (demo)" : ""}`}
            alt={`${categoryNames[report.category]} a ${report.location}`}
            keyboard
            zIndexOffset={props.selectedId === report.id ? 1000 : 0}
            eventHandlers={{ click: () => props.onSelect(report.id) }}
          />
        ))}
        {props.picking && props.pickedPosition && (
          <Marker
            position={[
              props.pickedPosition.latitude,
              props.pickedPosition.longitude,
            ]}
            icon={pickedIcon}
            title="Posizione della nuova segnalazione"
            alt="Posizione scelta per la segnalazione"
            interactive={false}
            zIndexOffset={2000}
          />
        )}
      </MapContainer>
      {tileWarning && (
        <div className="map-tile-warning" role="status">
          <span>
            La mappa non è disponibile. Controlla la connessione; le
            segnalazioni restano consultabili.
          </span>
          <button type="button" onClick={retryTiles}>
            Riprova
          </button>
        </div>
      )}
    </div>
  );
}
