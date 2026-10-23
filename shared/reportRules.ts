/** Shared rules for road reports, used by the browser and both backends. */
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
