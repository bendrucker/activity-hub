import { Decoder, Stream } from "@garmin/fitsdk";
import polyline from "@mapbox/polyline";
import { decodeGpx } from "./gpx";
import {
  gunzip,
  nullIsland,
  position,
  type TelemetryRecord,
} from "./telemetry";

export type TrackPoint = [latitude: number, longitude: number];

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

// Deliberately a bare record scan rather than decodeFit. Callers want
// position alone, for timezone inference, while decodeFit materializes every
// telemetry column: the largest corpus file expands to roughly 100,000 record
// objects, which is not a cost a 128 MB Worker should pay for coordinates.
function fitTrack(bytes: Uint8Array): TrackPoint[] {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  if (!decoder.isFIT()) {
    throw new Error("not a FIT file");
  }
  const { messages, errors } = decoder.read();
  const records = messages.recordMesgs ?? [];
  // A truncated file (device died mid-ride) reports a trailing decode error
  // but still yields its record messages. Only fail when nothing decoded.
  if (records.length === 0 && errors.length > 0) {
    throw new Error(`FIT decode failed: ${errors[0]}`);
  }
  const points: TrackPoint[] = [];
  for (const record of records) {
    const { latitude, longitude } = position(
      record.positionLat,
      record.positionLong,
    );
    if (latitude !== null && longitude !== null) {
      points.push([latitude, longitude]);
    }
  }
  return points;
}

// decodeGpx drops null island itself and throws when a document holds no
// trackpoints. A trackless file is not a parse failure to these callers, and
// the FIT and TCX paths already return [] for one, so the throw becomes [].
function gpxTrack(bytes: Uint8Array): TrackPoint[] {
  let records: TelemetryRecord[];
  try {
    records = decodeGpx(bytes).records;
  } catch {
    return [];
  }
  const points: TrackPoint[] = [];
  for (const { position_lat: lat, position_lon: lon } of records) {
    if (lat !== null && lon !== null) {
      points.push([lat, lon]);
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
    if (lat && lon && !nullIsland(Number(lat), Number(lon))) {
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
