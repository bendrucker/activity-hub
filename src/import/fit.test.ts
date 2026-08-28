import {
  CrcCalculator,
  Encoder,
  Profile,
  Utils,
  type DeveloperDataIdMesg,
  type DeviceInfoMesg,
  type Encodable,
  type FieldDescriptionMesg,
  type FileIdMesg,
  type LapMesg,
  type RecordMesg,
  type SessionMesg,
} from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { decodeFit } from "./fit";

// Synthetic route near Golden Gate Park. Not a real ride.
const LAT = 37.7715;
const LON = -122.4609;
const SEMICIRCLES = 2 ** 31 / 180;

const START = new Date("2026-01-15T17:00:00Z");

// A device whose clock never synced stamps records with seconds since it
// powered on. The encoder writes a Date as its offset from the FIT epoch, so a
// Date this close to that epoch encodes as the small system-time value.
const FIT_EPOCH = new Date("1989-12-31T00:00:00Z");
const UNSYNCED = new Date(FIT_EPOCH.getTime() + 1_000_000);

const FILE_ID = Profile.MesgNum.FILE_ID as number;
const RECORD = Profile.MesgNum.RECORD as number;
const LAP = Profile.MesgNum.LAP as number;
const SESSION = Profile.MesgNum.SESSION as number;
const DEVELOPER_DATA_ID = Profile.MesgNum.DEVELOPER_DATA_ID as number;
const FIELD_DESCRIPTION = Profile.MesgNum.FIELD_DESCRIPTION as number;
const DEVICE_INFO = Profile.MesgNum.DEVICE_INFO as number;
const FLOAT32 = Utils.FitBaseType.FLOAT32;

const FILE_ID_MESG: Encodable<FileIdMesg> = {
  mesgNum: FILE_ID,
  type: "activity",
  manufacturer: "garmin",
  product: 2713,
  garminProduct: "edge1030",
  timeCreated: START,
  serialNumber: 1234,
};

function semicircles(degrees: number): number {
  return Math.round(degrees * SEMICIRCLES);
}

function developerField(
  developerDataIndex: number,
  fieldDefinitionNumber: number,
  fieldName: string,
): Encodable<FieldDescriptionMesg> {
  return {
    mesgNum: FIELD_DESCRIPTION,
    developerDataIndex,
    fieldDefinitionNumber,
    fitBaseTypeId: FLOAT32,
    fieldName,
    units: "m",
    nativeMesgNum: RECORD,
  };
}

function developerDataId(developerDataIndex: number): Encodable<DeveloperDataIdMesg> {
  return {
    mesgNum: DEVELOPER_DATA_ID,
    developerDataIndex,
    applicationId: Array.from({ length: 16 }, () => developerDataIndex),
  };
}

function encode(
  mesgs: Encodable<RecordMesg | LapMesg | SessionMesg>[],
  descriptions: Encodable<FieldDescriptionMesg>[] = [],
  redeclarations: Encodable<FieldDescriptionMesg>[][] = [],
): Uint8Array {
  const encoder = new Encoder();
  const ids = new Map<number, Encodable<DeveloperDataIdMesg>>();
  descriptions.forEach((description, key) => {
    const index = Number(description.developerDataIndex);
    const id = ids.get(index) ?? developerDataId(index);
    ids.set(index, id);
    encoder.addDeveloperField(key, id, description);
  });

  encoder.writeMesg(FILE_ID_MESG);
  // addDeveloperField only teaches the encoder the field layout. The decoder
  // cannot resolve the keys unless the messages are in the file too. Repeating
  // a block replaces each developer data index rather than extending it, so
  // every round hands back the same keys again.
  for (const round of [descriptions, ...redeclarations]) {
    for (const id of ids.values()) {
      encoder.writeMesg(id);
    }
    for (const description of round) {
      encoder.writeMesg(description);
    }
  }
  for (const mesg of mesgs) {
    encoder.writeMesg(mesg);
  }
  return encoder.close();
}

// Overwrites an encoded float32 value with the all-ones pattern a device
// writes for a field it never set. The Encoder cannot produce it: given NaN it
// substitutes the invalid integer and writes that as a float.
function invalidateFloat(bytes: Uint8Array, value: number): Uint8Array {
  const needle = new Uint8Array(4);
  new DataView(needle.buffer).setFloat32(0, value, true);
  const at = bytes.findIndex((_byte, index) =>
    needle.every((expected, offset) => bytes[index + offset] === expected),
  );
  if (at < 0) {
    throw new Error(`no float32 ${value} in the encoded file`);
  }

  const patched = Uint8Array.from(bytes);
  patched.fill(0xff, at, at + 4);

  // The trailing two bytes are the file CRC over everything before them.
  const end = patched.length - 2;
  new DataView(patched.buffer).setUint16(end, CrcCalculator.calculateCRC(patched, 0, end), true);
  return patched;
}

// Overwrites one element of an encoded uint16 array with the all-ones pattern
// a device writes for a reading it never took. The Encoder cannot produce it:
// it validates each element and rejects the invalid value outright.
function invalidateArrayElement(bytes: Uint8Array, values: number[], element: number): Uint8Array {
  const needle = new Uint8Array(values.length * 2);
  const write = new DataView(needle.buffer);
  values.forEach((value, index) => write.setUint16(index * 2, value, true));
  const at = bytes.findIndex((_byte, index) =>
    needle.every((expected, offset) => bytes[index + offset] === expected),
  );
  if (at < 0) {
    throw new Error(`no uint16 array [${values}] in the encoded file`);
  }

  const patched = Uint8Array.from(bytes);
  new DataView(patched.buffer).setUint16(at + element * 2, 0xffff, true);

  // The trailing two bytes are the file CRC over everything before them.
  const end = patched.length - 2;
  new DataView(patched.buffer).setUint16(end, CrcCalculator.calculateCRC(patched, 0, end), true);
  return patched;
}

const FULL_RECORD: Encodable<RecordMesg> = {
  mesgNum: RECORD,
  timestamp: START,
  positionLat: semicircles(LAT),
  positionLong: semicircles(LON),
  enhancedAltitude: 100,
  distance: 12.5,
  enhancedSpeed: 5.75,
  power: 220,
  cadence: 90,
  fractionalCadence: 0.5,
  heartRate: 140,
  temperature: 21,
  grade: 2.5,
  leftRightBalance: 178,
  accumulatedPower: 5000,
  gpsAccuracy: 3,
};

describe("decodeFit", () => {
  it("projects the typed column set into SI values", () => {
    const activity = decodeFit(encode([FULL_RECORD]));
    expect(activity.source).toBe("fit");
    expect(activity.errors).toEqual([]);
    expect(activity.records).toHaveLength(1);

    const record = activity.records[0];
    expect(record?.timestamp).toEqual(START);
    expect(record?.position_lat).toBeCloseTo(LAT, 5);
    expect(record?.position_lon).toBeCloseTo(LON, 5);
    expect(record?.altitude).toBeCloseTo(100, 5);
    expect(record?.distance).toBeCloseTo(12.5, 5);
    expect(record?.speed).toBeCloseTo(5.75, 5);
    expect(record?.power).toBe(220);
    expect(record?.heart_rate).toBe(140);
    expect(record?.temperature).toBe(21);
    expect(record?.grade).toBeCloseTo(2.5, 5);
    expect(record?.left_right_balance).toBe(178);
    expect(record?.accumulated_power).toBe(5000);
    expect(record?.gps_accuracy).toBe(3);
    expect(record?.segment).toBe(0);
    expect(record?.developer_fields).toBeNull();
  });

  it("folds fractionalCadence into cadence", () => {
    const activity = decodeFit(
      encode([
        FULL_RECORD,
        { mesgNum: RECORD, timestamp: START, cadence: 80 },
        { mesgNum: RECORD, timestamp: START, heartRate: 100 },
      ]),
    );
    expect(activity.records.map((record) => record.cadence)).toEqual([90.5, 80, null]);
  });

  it("prefers the enhanced variant and falls back to the base field", () => {
    const activity = decodeFit(
      encode([
        { mesgNum: RECORD, timestamp: START, enhancedSpeed: 30 },
        { mesgNum: RECORD, timestamp: START, speed: 4.5 },
      ]),
    );
    expect(activity.records[0]?.speed).toBeCloseTo(30, 5);
    expect(activity.records[1]?.speed).toBeCloseTo(4.5, 5);
  });

  it("leaves missing fields null rather than undefined", () => {
    const activity = decodeFit(encode([{ mesgNum: RECORD, timestamp: START, heartRate: 100 }]));
    const record = activity.records[0];
    expect(record?.power).toBeNull();
    expect(record?.distance).toBeNull();
    expect(Object.values(record ?? {})).not.toContain(undefined);
  });

  it("drops position from a null island record but keeps its other columns", () => {
    const activity = decodeFit(
      encode([
        {
          mesgNum: RECORD,
          timestamp: START,
          positionLat: 0,
          positionLong: 0,
          heartRate: 141,
          power: 200,
        },
      ]),
    );
    const record = activity.records[0];
    expect(record?.position_lat).toBeNull();
    expect(record?.position_lon).toBeNull();
    expect(record?.heart_rate).toBe(141);
    expect(record?.power).toBe(200);
  });

  it("drops position when only one coordinate is present", () => {
    const activity = decodeFit(
      encode([
        {
          mesgNum: RECORD,
          timestamp: START,
          positionLat: semicircles(LAT),
          heartRate: 141,
        },
      ]),
    );
    expect(activity.records[0]?.position_lat).toBeNull();
    expect(activity.records[0]?.position_lon).toBeNull();
    expect(activity.records[0]?.heart_rate).toBe(141);
  });

  it("decodes laps", () => {
    const lap: Encodable<LapMesg> = {
      mesgNum: LAP,
      messageIndex: 0,
      timestamp: new Date(START.getTime() + 60_000),
      startTime: START,
      startPositionLat: semicircles(LAT),
      startPositionLong: semicircles(LON),
      endPositionLat: 0,
      endPositionLong: 0,
      totalElapsedTime: 60,
      totalTimerTime: 58,
      totalDistance: 500,
      totalCalories: 40,
      totalAscent: 12,
      totalDescent: 8,
      enhancedAvgSpeed: 8.5,
      maxSpeed: 12.25,
      avgHeartRate: 150,
      maxHeartRate: 165,
      avgCadence: 88,
      avgFractionalCadence: 0.25,
      avgPower: 210,
      normalizedPower: 230,
      intensity: "active",
      lapTrigger: "manual",
      sport: "cycling",
      subSport: "road",
    };
    const activity = decodeFit(encode([lap]));
    expect(activity.laps).toHaveLength(1);
    expect(activity.sessions).toEqual([]);

    const decoded = activity.laps[0];
    expect(decoded?.message_index).toBe(0);
    expect(decoded?.start_time).toEqual(START);
    expect(decoded?.start_position_lat).toBeCloseTo(LAT, 5);
    expect(decoded?.start_position_lon).toBeCloseTo(LON, 5);
    expect(decoded?.end_position_lat).toBeNull();
    expect(decoded?.end_position_lon).toBeNull();
    expect(decoded?.total_elapsed_time).toBeCloseTo(60, 5);
    expect(decoded?.total_distance).toBeCloseTo(500, 5);
    expect(decoded?.total_ascent).toBe(12);
    expect(decoded?.avg_speed).toBeCloseTo(8.5, 5);
    expect(decoded?.max_speed).toBeCloseTo(12.25, 5);
    expect(decoded?.avg_cadence).toBeCloseTo(88.25, 5);
    expect(decoded?.normalized_power).toBe(230);
    expect(decoded?.intensity).toBe("active");
    expect(decoded?.lap_trigger).toBe("manual");
    expect(decoded?.sport).toBe("cycling");
    expect(decoded?.sub_sport).toBe("road");
    expect(decoded?.avg_temperature).toBeNull();
  });

  it("decodes sessions", () => {
    const session: Encodable<SessionMesg> = {
      mesgNum: SESSION,
      messageIndex: 0,
      timestamp: new Date(START.getTime() + 60_000),
      startTime: START,
      startPositionLat: semicircles(LAT),
      startPositionLong: semicircles(LON),
      sport: "cycling",
      subSport: "road",
      trigger: "activityEnd",
      totalElapsedTime: 60,
      totalDistance: 500,
      totalWork: 12_600,
      thresholdPower: 250,
      trainingStressScore: 42.5,
      intensityFactor: 0.85,
      totalTrainingEffect: 3.2,
      avgTemperature: 20,
      numLaps: 1,
      firstLapIndex: 0,
    };
    const activity = decodeFit(encode([session]));
    expect(activity.sessions).toHaveLength(1);

    const decoded = activity.sessions[0];
    expect(decoded?.sport).toBe("cycling");
    expect(decoded?.sub_sport).toBe("road");
    expect(decoded?.trigger).toBe("activityEnd");
    expect(decoded?.start_position_lat).toBeCloseTo(LAT, 5);
    expect(decoded?.total_work).toBe(12_600);
    expect(decoded?.threshold_power).toBe(250);
    expect(decoded?.training_stress_score).toBeCloseTo(42.5, 5);
    expect(decoded?.intensity_factor).toBeCloseTo(0.85, 3);
    expect(decoded?.total_training_effect).toBeCloseTo(3.2, 1);
    expect(decoded?.avg_temperature).toBe(20);
    expect(decoded?.num_laps).toBe(1);
    expect(decoded?.first_lap_index).toBe(0);
  });

  it("reads the device from the file id and the creator device info", () => {
    const creator: Encodable<DeviceInfoMesg> = {
      mesgNum: DEVICE_INFO,
      timestamp: START,
      deviceIndex: 0,
      manufacturer: "garmin",
      productName: "Edge 1030",
      softwareVersion: 9.5,
      hardwareVersion: 1,
    };
    const encoder = new Encoder();
    encoder.writeMesg(FILE_ID_MESG);
    encoder.writeMesg(creator);
    encoder.writeMesg(FULL_RECORD);

    const activity = decodeFit(encoder.close());
    expect(activity.device).toEqual({
      manufacturer: "garmin",
      product: "edge1030",
      product_name: "Edge 1030",
      serial_number: 1234,
      software_version: 9.5,
      hardware_version: 1,
      time_created: START,
    });
  });

  it("reports no device when the file has no file id message", () => {
    const encoder = new Encoder();
    encoder.writeMesg(FULL_RECORD);
    expect(decodeFit(encoder.close()).device).toBeNull();
  });
});

describe("decodeFit developer fields", () => {
  it("resolves record values onto descriptor names", () => {
    const activity = decodeFit(
      encode(
        [
          {
            mesgNum: RECORD,
            timestamp: START,
            heartRate: 120,
            developerFields: { 0: 0, 1: 2 },
          },
        ],
        [developerField(0, 0, "ascent"), developerField(0, 1, "descent")],
      ),
    );

    expect(activity.records[0]?.developer_fields).toEqual({
      ascent: 0,
      descent: 2,
    });
    expect(activity.developerFields).toEqual([
      {
        name: "ascent",
        field_name: "ascent",
        developer_data_index: 0,
        field_definition_number: 0,
        units: "m",
        base_type_id: FLOAT32,
        native_mesg_num: RECORD,
      },
      {
        name: "descent",
        field_name: "descent",
        developer_data_index: 0,
        field_definition_number: 1,
        units: "m",
        base_type_id: FLOAT32,
        native_mesg_num: RECORD,
      },
    ]);
  });

  it("suffixes a repeated field name with its developer data index", () => {
    const activity = decodeFit(
      encode(
        [
          {
            mesgNum: RECORD,
            timestamp: START,
            developerFields: { 0: 1.5, 1: 2.5 },
          },
        ],
        [developerField(0, 0, "smoothness"), developerField(2, 0, "smoothness")],
      ),
    );

    expect(activity.records[0]?.developer_fields).toEqual({
      smoothness: 1.5,
      "smoothness@2": 2.5,
    });
    expect(activity.developerFields.map((field) => field.name)).toEqual([
      "smoothness",
      "smoothness@2",
    ]);
    expect(activity.developerFields.map((field) => field.field_name)).toEqual([
      "smoothness",
      "smoothness",
    ]);
  });

  it("collapses a descriptor block declared three times over", () => {
    const block = [developerField(0, 0, "calibration"), developerField(1, 0, "charge")];
    const activity = decodeFit(
      encode(
        [
          {
            mesgNum: RECORD,
            timestamp: START,
            developerFields: { 0: 1.5, 1: 2.5 },
          },
        ],
        block,
        [block, block],
      ),
    );

    expect(activity.errors).toEqual([]);
    expect(activity.developerFields.map((field) => field.name)).toEqual(["calibration", "charge"]);
    expect(activity.records[0]?.developer_fields).toEqual({
      calibration: 1.5,
      charge: 2.5,
    });
  });

  it("reports a key redeclared under a conflicting field name", () => {
    const activity = decodeFit(
      encode(
        [{ mesgNum: RECORD, timestamp: START, developerFields: { 0: 1.5 } }],
        [developerField(0, 0, "calibration")],
        [[developerField(0, 0, "charge")]],
      ),
    );

    expect(activity.errors).toEqual([
      "developer field key 0 redeclared as charge, keeping calibration",
    ]);
    expect(activity.developerFields.map((field) => field.name)).toEqual(["calibration"]);
    expect(activity.records[0]?.developer_fields).toEqual({
      calibration: 1.5,
    });
  });

  it("resolves developer fields on laps and sessions", () => {
    const stiffness = developerField(0, 0, "leg_spring_stiffness");
    stiffness.nativeMesgNum = LAP;

    const activity = decodeFit(
      encode(
        [
          {
            mesgNum: LAP,
            messageIndex: 0,
            timestamp: START,
            developerFields: { 0: 9.5 },
          },
          {
            mesgNum: SESSION,
            messageIndex: 0,
            timestamp: START,
            developerFields: { 0: 8.5 },
          },
        ],
        [stiffness],
      ),
    );

    expect(activity.laps[0]?.developer_fields).toEqual({
      leg_spring_stiffness: 9.5,
    });
    expect(activity.sessions[0]?.developer_fields).toEqual({
      leg_spring_stiffness: 8.5,
    });
  });

  it("carries string and array developer field values", () => {
    const label = developerField(0, 0, "workout_label");
    label.fitBaseTypeId = Utils.FitBaseType.STRING;
    const zones = developerField(0, 1, "zone_seconds");
    zones.fitBaseTypeId = Utils.FitBaseType.UINT16;
    zones.array = 3;

    const activity = decodeFit(
      encode(
        [
          {
            mesgNum: RECORD,
            timestamp: START,
            developerFields: { 0: "tempo", 1: [10, 20, 30] },
          },
        ],
        [label, zones],
      ),
    );

    expect(activity.records[0]?.developer_fields).toEqual({
      workout_label: "tempo",
      zone_seconds: [10, 20, 30],
    });
  });

  it("keeps an array numeric when one of its elements is invalid", () => {
    const zones = developerField(0, 0, "zone_seconds");
    zones.fitBaseTypeId = Utils.FitBaseType.UINT16;
    zones.array = 3;

    const bytes = encode(
      [
        {
          mesgNum: RECORD,
          timestamp: START,
          heartRate: 120,
          developerFields: { 0: [10, 20, 30] },
        },
      ],
      [zones],
    );

    // The SDK nulls invalid elements one at a time rather than dropping the
    // whole field, so a device that missed the middle reading hands back
    // [10, null, 30]. Requiring every element to be a number rejected that on
    // `typeof null === "object"` and sent the array down the string branch,
    // retyping the two readings that were fine as "10" and "30". One absent
    // element silently changed the column's type for the whole file.
    const activity = decodeFit(invalidateArrayElement(bytes, [10, 20, 30], 1));

    expect(activity.errors).toEqual([]);
    expect(activity.records[0]?.developer_fields).toEqual({
      zone_seconds: [10, null, 30],
    });
    const zoneSeconds = activity.records[0]?.developer_fields?.zone_seconds;
    expect(Array.isArray(zoneSeconds) ? zoneSeconds.map((item) => typeof item) : []).toEqual([
      "number",
      "object",
      "number",
    ]);
  });
});

describe("decodeFit missing values", () => {
  it("keeps a genuine zero reading rather than nulling it", () => {
    const activity = decodeFit(
      encode([
        {
          mesgNum: RECORD,
          timestamp: START,
          heartRate: 0,
          power: 0,
          cadence: 0,
          distance: 0,
        },
      ]),
    );
    const record = activity.records[0];
    expect(record?.heart_rate).toBe(0);
    expect(record?.power).toBe(0);
    expect(record?.cadence).toBe(0);
    expect(record?.distance).toBe(0);
  });

  it("nulls a float field carrying the FIT invalid pattern instead of NaN", () => {
    const ascent = developerField(0, 0, "ascent");
    const bytes = encode(
      [
        {
          mesgNum: RECORD,
          timestamp: START,
          heartRate: 120,
          developerFields: { 0: 42.5 },
        },
      ],
      [ascent],
    );

    // The SDK compares a float against the integer 0xFFFFFFFF to detect an
    // unset field, so the invalid bytes a device writes decode to NaN.
    const patched = invalidateFloat(bytes, 42.5);
    const activity = decodeFit(patched);

    expect(activity.errors).toEqual([]);
    expect(activity.records[0]?.developer_fields).toEqual({ ascent: null });
    expect(activity.records[0]?.heart_rate).toBe(120);
  });

  it("nulls a timestamp counting seconds since power-on, not since the epoch", () => {
    // A FIT datetime below 0x10000000 is system time: seconds since the device
    // booted, not an offset from the FIT epoch. `convertDateTimeToDate`
    // converts both the same way, so an unsynced head unit produced a date in
    // the early 1990s that reads as a real one everywhere downstream.
    const activity = decodeFit(
      encode([
        { mesgNum: RECORD, timestamp: UNSYNCED, heartRate: 100 },
        { mesgNum: RECORD, timestamp: START, heartRate: 101 },
      ]),
    );

    expect(activity.records[0]?.timestamp).toBeNull();
    expect(activity.records[0]?.heart_rate).toBe(100);
    // The guard rejects a range that ends in 2038. Nothing above it may go
    // with it.
    expect(activity.records[1]?.timestamp).toEqual(START);
  });

  it("omits a field written as an empty string", () => {
    const fileId: Encodable<FileIdMesg> = { ...FILE_ID_MESG, productName: "" };
    const encoder = new Encoder();
    encoder.writeMesg(fileId);
    encoder.writeMesg(FULL_RECORD);
    expect(decodeFit(encoder.close()).device?.product_name).toBeNull();
  });
});

describe("decodeFit failures", () => {
  it("rejects bytes that are not a FIT file", () => {
    expect(() => decodeFit(new TextEncoder().encode("not fit"))).toThrow("not a FIT file");
  });

  it("keeps the records of a truncated file and reports the decode error", () => {
    const bytes = encode([FULL_RECORD, { mesgNum: RECORD, timestamp: START, heartRate: 141 }]);
    const activity = decodeFit(bytes.slice(0, -2));
    expect(activity.records).toHaveLength(2);
    expect(activity.errors).toHaveLength(1);
    expect(activity.errors[0]).toContain("FIT Runtime Error");
  });

  it("throws when a file with decode errors yields no messages", () => {
    const bytes = encode([FULL_RECORD]);
    const garbage = new Uint8Array(60);
    garbage.set(bytes.slice(0, 14));
    garbage.fill(0x5a, 14);
    expect(() => decodeFit(garbage)).toThrow("FIT decode failed");
  });
});
