import { decodeFit } from "./fit";
import { decodeGpx } from "./gpx";

export type TelemetrySource = "fit" | "gpx";

// FIT developer fields carry whatever base type the descriptor declared, and
// array base types decode to arrays.
export type DeveloperFieldValue = number | string | number[] | string[] | null;

export interface TelemetryRecord {
  timestamp: Date | null;
  position_lat: number | null;
  position_lon: number | null;
  altitude: number | null;
  distance: number | null;
  speed: number | null;
  power: number | null;
  cadence: number | null;
  heart_rate: number | null;
  temperature: number | null;
  grade: number | null;
  left_right_balance: number | null;
  accumulated_power: number | null;
  gps_accuracy: number | null;
  // Recording segments, incremented across a pause. GPX marks them with
  // separate <trkseg> elements. FIT has no equivalent, so every FIT record
  // sits in segment 0.
  segment: number;
  developer_fields: Record<string, DeveloperFieldValue> | null;
}

export interface TelemetryLap {
  message_index: number | null;
  timestamp: Date | null;
  start_time: Date | null;
  start_position_lat: number | null;
  start_position_lon: number | null;
  end_position_lat: number | null;
  end_position_lon: number | null;
  total_elapsed_time: number | null;
  total_timer_time: number | null;
  total_moving_time: number | null;
  total_distance: number | null;
  total_calories: number | null;
  total_work: number | null;
  total_ascent: number | null;
  total_descent: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  min_heart_rate: number | null;
  avg_cadence: number | null;
  max_cadence: number | null;
  avg_power: number | null;
  max_power: number | null;
  normalized_power: number | null;
  avg_altitude: number | null;
  min_altitude: number | null;
  max_altitude: number | null;
  avg_grade: number | null;
  avg_temperature: number | null;
  max_temperature: number | null;
  intensity: string | null;
  lap_trigger: string | null;
  sport: string | null;
  sub_sport: string | null;
  developer_fields: Record<string, DeveloperFieldValue> | null;
}

export interface TelemetrySession {
  message_index: number | null;
  timestamp: Date | null;
  start_time: Date | null;
  start_position_lat: number | null;
  start_position_lon: number | null;
  end_position_lat: number | null;
  end_position_lon: number | null;
  sport: string | null;
  sub_sport: string | null;
  total_elapsed_time: number | null;
  total_timer_time: number | null;
  total_moving_time: number | null;
  total_distance: number | null;
  total_calories: number | null;
  total_work: number | null;
  total_ascent: number | null;
  total_descent: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  min_heart_rate: number | null;
  avg_cadence: number | null;
  max_cadence: number | null;
  avg_power: number | null;
  max_power: number | null;
  normalized_power: number | null;
  threshold_power: number | null;
  training_stress_score: number | null;
  intensity_factor: number | null;
  total_training_effect: number | null;
  avg_altitude: number | null;
  min_altitude: number | null;
  max_altitude: number | null;
  avg_grade: number | null;
  avg_temperature: number | null;
  max_temperature: number | null;
  num_laps: number | null;
  first_lap_index: number | null;
  trigger: string | null;
  developer_fields: Record<string, DeveloperFieldValue> | null;
}

export interface TelemetryDevice {
  manufacturer: string | null;
  product: string | null;
  product_name: string | null;
  serial_number: number | null;
  software_version: number | null;
  hardware_version: number | null;
  time_created: Date | null;
}

// The resolved name is what records key on. `field_name` is the descriptor's
// own name, which two descriptors in one file may share.
export interface DeveloperFieldDescriptor {
  name: string;
  field_name: string;
  developer_data_index: number | null;
  field_definition_number: number | null;
  units: string | null;
  base_type_id: number | null;
  native_mesg_num: number | null;
}

export interface TelemetryActivity {
  source: TelemetrySource;
  records: TelemetryRecord[];
  laps: TelemetryLap[];
  sessions: TelemetrySession[];
  device: TelemetryDevice | null;
  developerFields: DeveloperFieldDescriptor[];
  // Decode errors are carried rather than thrown so a partial decode is
  // recorded instead of lost. Decoders throw only when nothing decoded.
  errors: string[];
}

export async function decodeTelemetry(
  bytes: Uint8Array,
  filename: string,
): Promise<TelemetryActivity> {
  if (filename.endsWith(".gz")) {
    return decodeTelemetry(await gunzip(bytes), filename.slice(0, -3));
  }
  if (filename.endsWith(".fit")) {
    return decodeFit(bytes);
  }
  if (filename.endsWith(".gpx")) {
    return decodeGpx(bytes);
  }
  throw new Error(`unsupported telemetry file ${filename}`);
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const SEMICIRCLE_DEGREES = 180 / 2 ** 31;

export function semicircleDegrees(semicircles: number): number {
  return semicircles * SEMICIRCLE_DEGREES;
}

// Some devices log (0, 0) before satellite lock. A real track point at
// null island is not a case this athlete's history contains.
export function nullIsland(lat: number, lon: number): boolean {
  return lat === 0 && lon === 0;
}

export function emptyActivity(source: TelemetrySource): TelemetryActivity {
  return {
    source,
    records: [],
    laps: [],
    sessions: [],
    device: null,
    developerFields: [],
    errors: [],
  };
}
