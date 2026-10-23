/** Shared rules for road reports, used by the browser and both backends. */
export const CATEGORY_VALUES = [
  "pothole",
  "rough_road",
  "gravel",
  "dirt",
  "mud",
  "oil",
  "obstacle",
  "closure",
  "mobile_speed_camera",
  "other",
] as const;
export type Category = (typeof CATEGORY_VALUES)[number];

export const DEFAULT_REPORT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MOBILE_REPORT_LIFETIME_MS = 60 * 60 * 1000;

export function reportLifetimeMs(category: string): number {
  return category === "mobile_speed_camera"
    ? MOBILE_REPORT_LIFETIME_MS
    : DEFAULT_REPORT_LIFETIME_MS;
}

export const CLEAR_VOTE_THRESHOLD = 3;
export const DUPLICATE_RADIUS_METERS = 75;

/** Great-circle distance, including points on opposite sides of the date line. */
export function distanceMeters(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (latitude2 - latitude1) * radians;
  const longitudeDelta = (longitude2 - longitude1) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1 * radians) *
      Math.cos(latitude2 * radians) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}
