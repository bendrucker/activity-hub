import {
  emptyActivity,
  nullIsland,
  type TelemetryActivity,
  type TelemetryDevice,
  type TelemetryRecord,
} from "./telemetry";

// Strava writes a fixed GPX shape, so regex extraction stays cheaper than an
// XML parser dependency. Segments and points are matched with an alternation
// on the self-closing form so an empty element cannot swallow its successors.
const TRACK_SEGMENT = /<trkseg\b[^>]*?(?:\/>|>([\s\S]*?)<\/trkseg>)/g;
const TRACK_POINT = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;

// TRACK_POINT requires a closing tag, so a document truncated mid-track drops
// its trailing points with no match to notice, whether the truncation cut a
// point or the segment around it. Counting opening tags against what decoded
// turns that silence into a reported error.
const POINT_OPEN = /<trkpt\b/g;

const LATITUDE = /\blat="([^"]*)"/;
const LONGITUDE = /\blon="([^"]*)"/;
const CREATOR = /\bcreator="([^"]*)"/;
const GPX_ROOT = /<gpx\b([^>]*)>/;

// Extensions carry a namespace prefix that varies by writer (gpxtpx, ns3,
// none at all), so each element is matched on its local name.
const ELEVATION = element("ele");
const TIME = element("time");
const POWER = element("power");
const HEART_RATE = element("hr");
const CADENCE = element("cad");
const TEMPERATURE = element("atemp");

function element(name: string): RegExp {
  return new RegExp(`<(?:[^\\s:>]+:)?${name}\\b[^>]*>([^<]*)<`);
}

export function decodeGpx(bytes: Uint8Array): TelemetryActivity {
  const text = new TextDecoder().decode(bytes);
  const activity = emptyActivity("gpx");
  activity.device = decodeDevice(text);

  let segment = 0;
  let index = 0;
  for (const children of segments(text)) {
    for (const [, attributes, point] of children.matchAll(TRACK_POINT)) {
      activity.records.push(
        decodeTrackPoint(attributes ?? "", point ?? "", segment, index, activity.errors),
      );
      index++;
    }
    segment++;
  }

  const openPoints = count(text, POINT_OPEN);
  if (openPoints > index) {
    activity.errors.push(`${openPoints - index} unterminated trackpoint(s), document is truncated`);
  }

  if (activity.records.length === 0) {
    throw new Error("GPX decode failed: no trackpoints");
  }
  return activity;
}

// `trkseg` is optional in GPX 1.1, and a writer that omits it puts trackpoints
// directly under `trk`. Falling back to the whole document keeps those points
// rather than reading the file as trackless.
function segments(text: string): string[] {
  const matched = [...text.matchAll(TRACK_SEGMENT)].map(([, children]) => children ?? "");
  return matched.length > 0 ? matched : [text];
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function decodeTrackPoint(
  attributes: string,
  children: string,
  segment: number,
  index: number,
  errors: string[],
): TelemetryRecord {
  const record: TelemetryRecord = {
    timestamp: null,
    position_lat: null,
    position_lon: null,
    altitude: numberFrom(children, ELEVATION),
    distance: null,
    speed: null,
    power: numberFrom(children, POWER),
    cadence: numberFrom(children, CADENCE),
    heart_rate: numberFrom(children, HEART_RATE),
    temperature: numberFrom(children, TEMPERATURE),
    grade: null,
    left_right_balance: null,
    accumulated_power: null,
    gps_accuracy: null,
    segment,
    developer_fields: null,
  };

  const lat = numberFrom(attributes, LATITUDE);
  const lon = numberFrom(attributes, LONGITUDE);
  if (lat === null || lon === null) {
    errors.push(`trackpoint ${index}: no usable lat/lon`);
  } else if (!nullIsland(lat, lon)) {
    record.position_lat = lat;
    record.position_lon = lon;
  }

  const time = TIME.exec(children)?.[1]?.trim();
  if (time) {
    const timestamp = new Date(time);
    if (Number.isNaN(timestamp.getTime())) {
      errors.push(`trackpoint ${index}: unparseable time ${time}`);
    } else {
      record.timestamp = timestamp;
    }
  }

  return record;
}

function decodeDevice(text: string): TelemetryDevice | null {
  const attributes = GPX_ROOT.exec(text)?.[1];
  const creator = attributes ? CREATOR.exec(attributes)?.[1]?.trim() : null;
  if (!creator) {
    return null;
  }
  return {
    manufacturer: null,
    product: null,
    product_name: creator,
    serial_number: null,
    software_version: null,
    hardware_version: null,
    time_created: null,
  };
}

function numberFrom(text: string, pattern: RegExp): number | null {
  const raw = pattern.exec(text)?.[1]?.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
