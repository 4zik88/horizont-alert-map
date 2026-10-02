/** Spherical geometry on a 6371 km Earth. Accurate to well under 1% at Ukraine's scale. */

const RAD = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371;

/** Initial great-circle bearing in degrees, 0 = north, clockwise. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * RAD;
  const φ2 = lat2 * RAD;
  const Δλ = (lon2 - lon1) * RAD;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** The point reached by travelling `km` from a start along an initial bearing. */
export function destination(
  lat: number,
  lon: number,
  bearingDeg: number,
  km: number,
): { lat: number; lon: number } {
  const δ = km / EARTH_RADIUS_KM;
  const θ = bearingDeg * RAD;
  const φ1 = lat * RAD;
  const λ1 = lon * RAD;

  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );

  return { lat: φ2 / RAD, lon: (((λ2 / RAD + 540) % 360) - 180) };
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}
