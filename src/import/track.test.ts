import {
  Encoder,
  Profile,
  type Encodable,
  type FileIdMesg,
  type RecordMesg,
} from "@garmin/fitsdk";
import { decode } from "@mapbox/polyline";
import { describe, expect, it } from "vitest";
import { extractTrack, polylineDocument, type TrackPoint } from "./track";

// Synthetic route near Golden Gate Park. Not a real ride.
const LAT = 37.7715;
const LON = -122.4609;

const FILE_ID = Profile.MesgNum.FILE_ID as number;
const RECORD = Profile.MesgNum.RECORD as number;

function syntheticFit(points: number): Uint8Array {
  const start = new Date("2026-01-15T17:00:00Z");
  const encoder = new Encoder();
  const fileId: Encodable<FileIdMesg> = {
    mesgNum: FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: start,
    serialNumber: 1234,
  };
  encoder.writeMesg(fileId);
  for (let i = 0; i < points; i++) {
    const record: Encodable<RecordMesg> = {
      mesgNum: RECORD,
      timestamp: new Date(start.getTime() + i * 1000),
      positionLat: Math.round((LAT + i * 0.001) * (2 ** 31 / 180)),
      positionLong: Math.round(LON * (2 ** 31 / 180)),
    };
    encoder.writeMesg(record);
  }
  // A record without GPS (indoor segment) must not produce a point.
  const indoor: Encodable<RecordMesg> = {
    mesgNum: RECORD,
    timestamp: new Date(start.getTime() + points * 1000),
    heartRate: 120,
  };
  encoder.writeMesg(indoor);
  return encoder.close();
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1">
 <trk>
  <trkseg>
   <trkpt lat="40.7259600" lon="-74.0013940">
    <ele>5.2</ele>
    <time>2017-05-23T12:50:43Z</time>
   </trkpt>
   <trkpt lat="40.7258970" lon="-74.0012310">
    <ele>5.4</ele>
   </trkpt>
  </trkseg>
 </trk>
</gpx>`;

const TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase>
 <Activities><Activity Sport="Biking"><Lap><Track>
  <Trackpoint>
   <Time>2016-03-06T17:24:36Z</Time>
   <Position>
    <LatitudeDegrees>37.7715</LatitudeDegrees>
    <LongitudeDegrees>-122.4609</LongitudeDegrees>
   </Position>
  </Trackpoint>
  <Trackpoint>
   <Time>2016-03-06T17:24:40Z</Time>
  </Trackpoint>
 </Track></Lap></Activity></Activities>
</TrainingCenterDatabase>`;

describe("extractTrack", () => {
  it("extracts positioned records from FIT bytes", async () => {
    const points = await extractTrack(syntheticFit(5), "activities/1.fit");
    expect(points).toHaveLength(5);
    expect(points[0]?.[0]).toBeCloseTo(LAT, 4);
    expect(points[0]?.[1]).toBeCloseTo(LON, 4);
  });

  it("decompresses gzipped files before dispatching on the inner extension", async () => {
    const bytes = await gzip(syntheticFit(3));
    const points = await extractTrack(bytes, "activities/1.fit.gz");
    expect(points).toHaveLength(3);
  });

  it("parses GPX trackpoints", async () => {
    const points = await extractTrack(
      new TextEncoder().encode(GPX),
      "activities/2.gpx",
    );
    expect(points).toEqual([
      [40.72596, -74.001394],
      [40.725897, -74.001231],
    ]);
  });

  it("parses TCX trackpoints, skipping positionless ones", async () => {
    const points = await extractTrack(
      new TextEncoder().encode(TCX),
      "activities/3.tcx",
    );
    expect(points).toEqual([[37.7715, -122.4609]]);
  });

  it("keeps records from a truncated FIT file that reports decode errors", async () => {
    const bytes = syntheticFit(4);
    const points = await extractTrack(bytes.slice(0, -2), "activities/6.fit");
    expect(points).toHaveLength(4);
  });

  it("drops pre-lock (0, 0) points from GPX", async () => {
    const gpx = `<gpx><trk><trkseg>
     <trkpt lat="0.0" lon="0.0"></trkpt>
     <trkpt lat="40.7259600" lon="-74.0013940"></trkpt>
    </trkseg></trk></gpx>`;
    const points = await extractTrack(
      new TextEncoder().encode(gpx),
      "activities/7.gpx",
    );
    expect(points).toEqual([[40.72596, -74.001394]]);
  });

  it("drops pre-lock (0, 0) points from TCX", async () => {
    const tcx = `<TrainingCenterDatabase><Activities><Activity><Lap><Track>
     <Trackpoint><Position>
      <LatitudeDegrees>0.0</LatitudeDegrees>
      <LongitudeDegrees>0.0</LongitudeDegrees>
     </Position></Trackpoint>
     <Trackpoint><Position>
      <LatitudeDegrees>37.7715</LatitudeDegrees>
      <LongitudeDegrees>-122.4609</LongitudeDegrees>
     </Position></Trackpoint>
    </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const points = await extractTrack(
      new TextEncoder().encode(tcx),
      "activities/8.tcx",
    );
    expect(points).toEqual([[37.7715, -122.4609]]);
  });

  it("rejects unsupported extensions", async () => {
    await expect(
      extractTrack(new Uint8Array(), "activities/4.kml"),
    ).rejects.toThrow("unsupported track file");
  });

  it("rejects non-FIT bytes", async () => {
    await expect(
      extractTrack(new TextEncoder().encode("not fit"), "activities/5.fit"),
    ).rejects.toThrow("not a FIT file");
  });
});

describe("polylineDocument", () => {
  it("round-trips through polyline encoding", () => {
    const points: TrackPoint[] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    const document = polylineDocument(points);
    expect(document.points).toBe(3);
    expect(document.polyline).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decode(document.polyline)).toEqual(points);
  });
});
