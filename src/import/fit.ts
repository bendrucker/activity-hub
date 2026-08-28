import {
  Decoder,
  Stream,
  Utils,
  type DeveloperFields,
  type FieldDescriptionMesg,
  type FieldValue,
  type FitMessages,
  type LapMesg,
  type RecordMesg,
  type SessionMesg,
} from "@garmin/fitsdk";
import {
  position,
  type DeveloperFieldDescriptor,
  type DeveloperFieldValue,
  type TelemetryActivity,
  type TelemetryDevice,
  type TelemetryLap,
  type TelemetryRecord,
  type TelemetrySession,
} from "./telemetry";

// Records key developer fields on a per-file counter, so the names have to be
// carried alongside the messages to make any sense of them.
export type DeveloperFieldNames = ReadonlyMap<string, string>;

type ColumnSource<M, R> = {
  [K in keyof R]: (mesg: M, names: DeveloperFieldNames) => R[K];
};

export const RECORD_COLUMNS: ColumnSource<RecordMesg, TelemetryRecord> = {
  timestamp: (record) => date(record.timestamp),
  position_lat: (record) => position(record.positionLat, record.positionLong).latitude,
  position_lon: (record) => position(record.positionLat, record.positionLong).longitude,
  altitude: (record) => number(record.enhancedAltitude ?? record.altitude),
  distance: (record) => number(record.distance),
  speed: (record) => number(record.enhancedSpeed ?? record.speed),
  power: (record) => number(record.power),
  cadence: (record) => cadence(record.cadence, record.fractionalCadence),
  heart_rate: (record) => number(record.heartRate),
  temperature: (record) => number(record.temperature),
  grade: (record) => number(record.grade),
  left_right_balance: (record) => numeric(record.leftRightBalance),
  accumulated_power: (record) => number(record.accumulatedPower),
  gps_accuracy: (record) => number(record.gpsAccuracy),
  segment: () => 0,
  developer_fields: (record, names) => developerFields(record.developerFields, names),
};

export const LAP_COLUMNS: ColumnSource<LapMesg, TelemetryLap> = {
  message_index: (lap) => numeric(lap.messageIndex),
  timestamp: (lap) => date(lap.timestamp),
  start_time: (lap) => date(lap.startTime),
  start_position_lat: (lap) => position(lap.startPositionLat, lap.startPositionLong).latitude,
  start_position_lon: (lap) => position(lap.startPositionLat, lap.startPositionLong).longitude,
  end_position_lat: (lap) => position(lap.endPositionLat, lap.endPositionLong).latitude,
  end_position_lon: (lap) => position(lap.endPositionLat, lap.endPositionLong).longitude,
  total_elapsed_time: (lap) => number(lap.totalElapsedTime),
  total_timer_time: (lap) => number(lap.totalTimerTime),
  total_moving_time: (lap) => number(lap.totalMovingTime),
  total_distance: (lap) => number(lap.totalDistance),
  total_calories: (lap) => number(lap.totalCalories),
  total_work: (lap) => number(lap.totalWork),
  total_ascent: (lap) => number(lap.totalAscent),
  total_descent: (lap) => number(lap.totalDescent),
  avg_speed: (lap) => number(lap.enhancedAvgSpeed ?? lap.avgSpeed),
  max_speed: (lap) => number(lap.enhancedMaxSpeed ?? lap.maxSpeed),
  avg_heart_rate: (lap) => number(lap.avgHeartRate),
  max_heart_rate: (lap) => number(lap.maxHeartRate),
  min_heart_rate: (lap) => number(lap.minHeartRate),
  avg_cadence: (lap) => cadence(lap.avgCadence, lap.avgFractionalCadence),
  max_cadence: (lap) => cadence(lap.maxCadence, lap.maxFractionalCadence),
  avg_power: (lap) => number(lap.avgPower),
  max_power: (lap) => number(lap.maxPower),
  normalized_power: (lap) => number(lap.normalizedPower),
  avg_altitude: (lap) => number(lap.enhancedAvgAltitude ?? lap.avgAltitude),
  min_altitude: (lap) => number(lap.enhancedMinAltitude ?? lap.minAltitude),
  max_altitude: (lap) => number(lap.enhancedMaxAltitude ?? lap.maxAltitude),
  avg_grade: (lap) => number(lap.avgGrade),
  avg_temperature: (lap) => number(lap.avgTemperature),
  max_temperature: (lap) => number(lap.maxTemperature),
  intensity: (lap) => text(lap.intensity),
  lap_trigger: (lap) => text(lap.lapTrigger),
  sport: (lap) => text(lap.sport),
  sub_sport: (lap) => text(lap.subSport),
  developer_fields: (lap, names) => developerFields(lap.developerFields, names),
};

export const SESSION_COLUMNS: ColumnSource<SessionMesg, TelemetrySession> = {
  message_index: (session) => numeric(session.messageIndex),
  timestamp: (session) => date(session.timestamp),
  start_time: (session) => date(session.startTime),
  start_position_lat: (session) =>
    position(session.startPositionLat, session.startPositionLong).latitude,
  start_position_lon: (session) =>
    position(session.startPositionLat, session.startPositionLong).longitude,
  end_position_lat: (session) => position(session.endPositionLat, session.endPositionLong).latitude,
  end_position_lon: (session) =>
    position(session.endPositionLat, session.endPositionLong).longitude,
  sport: (session) => text(session.sport),
  sub_sport: (session) => text(session.subSport),
  total_elapsed_time: (session) => number(session.totalElapsedTime),
  total_timer_time: (session) => number(session.totalTimerTime),
  total_moving_time: (session) => number(session.totalMovingTime),
  total_distance: (session) => number(session.totalDistance),
  total_calories: (session) => number(session.totalCalories),
  total_work: (session) => number(session.totalWork),
  total_ascent: (session) => number(session.totalAscent),
  total_descent: (session) => number(session.totalDescent),
  avg_speed: (session) => number(session.enhancedAvgSpeed ?? session.avgSpeed),
  max_speed: (session) => number(session.enhancedMaxSpeed ?? session.maxSpeed),
  avg_heart_rate: (session) => number(session.avgHeartRate),
  max_heart_rate: (session) => number(session.maxHeartRate),
  min_heart_rate: (session) => number(session.minHeartRate),
  avg_cadence: (session) => cadence(session.avgCadence, session.avgFractionalCadence),
  max_cadence: (session) => cadence(session.maxCadence, session.maxFractionalCadence),
  avg_power: (session) => number(session.avgPower),
  max_power: (session) => number(session.maxPower),
  normalized_power: (session) => number(session.normalizedPower),
  threshold_power: (session) => number(session.thresholdPower),
  training_stress_score: (session) => number(session.trainingStressScore),
  intensity_factor: (session) => number(session.intensityFactor),
  total_training_effect: (session) => number(session.totalTrainingEffect),
  avg_altitude: (session) => number(session.enhancedAvgAltitude ?? session.avgAltitude),
  min_altitude: (session) => number(session.enhancedMinAltitude ?? session.minAltitude),
  max_altitude: (session) => number(session.enhancedMaxAltitude ?? session.maxAltitude),
  avg_grade: (session) => number(session.avgGrade),
  avg_temperature: (session) => number(session.avgTemperature),
  max_temperature: (session) => number(session.maxTemperature),
  num_laps: (session) => number(session.numLaps),
  first_lap_index: (session) => number(session.firstLapIndex),
  trigger: (session) => text(session.trigger),
  developer_fields: (session, names) => developerFields(session.developerFields, names),
};

export function decodeFit(bytes: Uint8Array): TelemetryActivity {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  // Reading consumes the stream, after which isFIT reports false.
  if (!decoder.isFIT()) {
    throw new Error("not a FIT file");
  }
  const { messages, errors } = decoder.read();

  const {
    descriptors,
    names,
    errors: fieldErrors,
  } = describeDeveloperFields(messages.fieldDescriptionMesgs ?? []);

  const records = project(RECORD_COLUMNS, messages.recordMesgs ?? [], names);
  const laps = project(LAP_COLUMNS, messages.lapMesgs ?? [], names);
  const sessions = project(SESSION_COLUMNS, messages.sessionMesgs ?? [], names);

  if (records.length === 0 && laps.length === 0 && sessions.length === 0 && errors.length > 0) {
    throw new Error(`FIT decode failed: ${errors[0]}`);
  }

  return {
    source: "fit",
    records,
    laps,
    sessions,
    device: device(messages),
    developerFields: descriptors,
    errors: [...errors.map(String), ...fieldErrors],
  };
}

function project<M, R>(source: ColumnSource<M, R>, mesgs: M[], names: DeveloperFieldNames): R[] {
  const columns = Object.keys(source) as (keyof R)[];
  return mesgs.map((mesg) => {
    const row = {} as R;
    for (const column of columns) {
      row[column] = source[column](mesg, names);
    }
    return row;
  });
}

interface DeveloperFieldTable {
  descriptors: DeveloperFieldDescriptor[];
  names: DeveloperFieldNames;
  errors: string[];
}

// The decoder keys developer values on how many descriptors it had seen when
// it read the descriptor, a number that means nothing outside this one file.
// Redeclaring a developer data index replaces its definition rather than
// appending to it, so a file that repeats its whole descriptor block hands
// back the same keys again.
function describeDeveloperFields(mesgs: FieldDescriptionMesg[]): DeveloperFieldTable {
  const descriptors: DeveloperFieldDescriptor[] = [];
  const names = new Map<string, string>();
  const declared = new Map<string, string>();
  const taken = new Set<string>();
  const errors: string[] = [];

  for (const [index, mesg] of mesgs.entries()) {
    const key = String(descriptorKey(mesg) ?? index);
    const developerDataIndex = numeric(mesg.developerDataIndex);
    const fieldName = mesg.fieldName ?? `field_${key}`;

    const first = declared.get(key);
    if (first != null) {
      if (first !== fieldName) {
        errors.push(`developer field key ${key} redeclared as ${fieldName}, keeping ${first}`);
      }
      continue;
    }

    const name = uniqueName(fieldName, developerDataIndex, taken);
    declared.set(key, fieldName);
    taken.add(name);
    names.set(key, name);
    descriptors.push({
      name,
      field_name: fieldName,
      developer_data_index: developerDataIndex,
      field_definition_number: numeric(mesg.fieldDefinitionNumber),
      units: text(mesg.units),
      base_type_id: baseTypeId(mesg.fitBaseTypeId),
      native_mesg_num: numeric(mesg.nativeMesgNum),
    });
  }

  return { descriptors, names, errors };
}

// Two applications in one file may both declare `running_smoothness`. The
// later declaration takes its developer data index as a suffix so both keep a
// column of their own.
function uniqueName(
  fieldName: string,
  developerDataIndex: number | null,
  taken: Set<string>,
): string {
  if (!taken.has(fieldName)) {
    return fieldName;
  }
  const indexed = `${fieldName}@${developerDataIndex ?? 0}`;
  let name = indexed;
  for (let attempt = 2; taken.has(name); attempt++) {
    name = `${indexed}#${attempt}`;
  }
  return name;
}

// The decoder attaches `key` to each field description after the fact, so it
// is absent from the SDK's message type.
function descriptorKey(mesg: FieldDescriptionMesg): number | null {
  const key = (mesg as Record<string, unknown>).key;
  return typeof key === "number" ? key : null;
}

function developerFields(
  fields: DeveloperFields | undefined,
  names: DeveloperFieldNames,
): Record<string, DeveloperFieldValue> | null {
  if (fields == null) {
    return null;
  }
  const resolved: Record<string, DeveloperFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    resolved[names.get(key) ?? key] = developerValue(value);
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
}

function developerValue(value: FieldValue | undefined): DeveloperFieldValue {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    // The SDK nulls invalid elements individually rather than the whole field,
    // so a numeric array routinely arrives as [10, null, 30]. Testing every
    // element against `typeof "number"` would send that to the string branch
    // and stringify the readings that were fine.
    return value.every((item) => item == null || typeof item === "number")
      ? value.map(number)
      : value.map((item) => (item == null ? null : String(item)));
  }
  if (typeof value === "number") {
    return number(value);
  }
  return typeof value === "string" ? value : String(value);
}

function device(messages: FitMessages): TelemetryDevice | null {
  const fileId = messages.fileIdMesgs?.[0];
  if (fileId == null) {
    return null;
  }
  const creator = messages.deviceInfoMesgs?.find(
    (info) => info.deviceIndex === "creator" || info.deviceIndex === 0,
  );
  return {
    manufacturer: text(fileId.manufacturer),
    product: text(fileId.garminProduct ?? fileId.faveroProduct ?? fileId.product),
    product_name: text(creator?.productName ?? fileId.productName),
    serial_number: number(fileId.serialNumber),
    software_version: number(creator?.softwareVersion),
    hardware_version: number(creator?.hardwareVersion),
    time_created: date(fileId.timeCreated),
  };
}

function cadence(whole: number | undefined, fractional: number | undefined): number | null {
  const base = number(whole);
  return base == null ? null : base + (number(fractional) ?? 0);
}

// A FIT datetime below 0x10000000 counts seconds since the device powered on
// rather than seconds since the FIT epoch. Nothing in the SDK distinguishes
// them, so a device whose clock never synced converts to a date in the early
// 1990s instead of failing. Below the threshold the value is that artifact:
// this athlete's history starts a decade after it.
const FIT_EPOCH_S = 631065600;
const SYSTEM_TIME_MAX_S = 0x10000000;
const ABSOLUTE_MIN_MS = (FIT_EPOCH_S + SYSTEM_TIME_MAX_S) * 1000;

function date(value: number | string | Date | undefined): Date | null {
  const converted =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? Utils.convertDateTimeToDate(value)
        : null;
  if (converted === null || converted.getTime() < ABSOLUTE_MIN_MS) {
    return null;
  }
  return converted;
}

// A float field holding the FIT invalid pattern decodes to NaN: the SDK's
// invalid check compares the read value against the integer 0xFFFFFFFF, which
// never equals the NaN that `getFloat32` returns for those bytes.
function number(value: number | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

// Fields whose profile type has string names are typed as `number | string`
// even where the decoder leaves them numeric.
function numeric(value: string | number | undefined): number | null {
  return typeof value === "number" ? number(value) : null;
}

function text(value: string | number | undefined): string | null {
  return value == null ? null : String(value);
}

function baseTypeId(value: string | number | undefined): number | null {
  return typeof value === "string" ? (Utils.FieldTypeToBaseType[value] ?? null) : number(value);
}
