import { Decoder, Stream } from "@garmin/fitsdk";
import polyline from "@mapbox/polyline";
import tzlookup from "tz-lookup";

export type TrackPoint = [latitude: number, longitude: number];

const SEMICIRCLE_DEGREES = 180 / 2 ** 31;

export async function extractTrack(
  bytes: Uint8Array,
  filename: string,
): Promise<TrackPoint[]> {
  if (filename.endsWith(".gz")) {
    return extractTrack(await gunzip(bytes), filename.slice(0, -3));
  }
  if (filename.endsWith(".fit")) {
    return fitTrack(bytes);
  }
  if (filename.endsWith(".gpx")) {
    return gpxTrack(bytes);
  }
  if (filename.endsWith(".tcx")) {
    return tcxTrack(bytes);
  }
  throw new Error(`unsupported track file ${filename}`);
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function fitTrack(bytes: Uint8Array): TrackPoint[] {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  if (!decoder.isFIT()) {
    throw new Error("not a FIT file");
  }
  const { messages, errors } = decoder.read();
  if (errors.length > 0) {
    throw new Error(`FIT decode failed: ${errors[0]}`);
  }
  const points: TrackPoint[] = [];
  for (const record of messages.recordMesgs ?? []) {
    if (record.positionLat == null || record.positionLong == null) {
      continue;
    }
    // Some devices log (0, 0) before satellite lock. A real track point at
    // null island is not a case this athlete's history contains.
    if (record.positionLat === 0 && record.positionLong === 0) {
      continue;
    }
    points.push([
      record.positionLat * SEMICIRCLE_DEGREES,
      record.positionLong * SEMICIRCLE_DEGREES,
    ]);
  }
  return points;
}

function gpxTrack(bytes: Uint8Array): TrackPoint[] {
  const text = new TextDecoder().decode(bytes);
  const points: TrackPoint[] = [];
  for (const [, attributes] of text.matchAll(/<trkpt\b([^>]*)>/g)) {
    const lat = /\blat="([-\d.]+)"/.exec(attributes ?? "");
    const lon = /\blon="([-\d.]+)"/.exec(attributes ?? "");
    if (lat?.[1] && lon?.[1]) {
      points.push([Number(lat[1]), Number(lon[1])]);
    }
  }
  return points;
}

function tcxTrack(bytes: Uint8Array): TrackPoint[] {
  const text = new TextDecoder().decode(bytes);
  const points: TrackPoint[] = [];
  const pattern =
    /<LatitudeDegrees>([-\d.]+)<\/LatitudeDegrees>\s*<LongitudeDegrees>([-\d.]+)<\/LongitudeDegrees>/g;
  for (const [, lat, lon] of text.matchAll(pattern)) {
    if (lat && lon) {
      points.push([Number(lat), Number(lon)]);
    }
  }
  return points;
}

export interface PolylineDocument {
  polyline: string;
  points: number;
}

export function polylineDocument(points: TrackPoint[]): PolylineDocument {
  return { polyline: polyline.encode(points), points: points.length };
}

export function trackTimezone(points: TrackPoint[]): string {
  const first = points[0];
  if (!first) {
    return "UTC";
  }
  try {
    return tzlookup(first[0], first[1]);
  } catch {
    return "UTC";
  }
}
