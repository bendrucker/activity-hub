import { describe, expect, it } from "vitest";
import { decodeGpx } from "./gpx";

function gpx(body: string, creator = 'creator="StravaGPX"'): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>
<gpx ${creator} version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <metadata>
  <time>2017-05-26T12:56:53Z</time>
 </metadata>
 <trk>
  <name>Work can wait for the Giro</name>
  <type>cycling</type>
${body}
 </trk>
</gpx>`,
  );
}

const INSTRUMENTED = gpx(`  <trkseg>
   <trkpt lat="37.7732320" lon="-122.4589040">
    <ele>86.0</ele>
    <time>2017-05-26T12:56:53Z</time>
    <extensions>
     <power>227</power>
     <gpxtpx:TrackPointExtension>
      <gpxtpx:atemp>24</gpxtpx:atemp>
      <gpxtpx:hr>146</gpxtpx:hr>
      <gpxtpx:cad>87</gpxtpx:cad>
     </gpxtpx:TrackPointExtension>
    </extensions>
   </trkpt>
  </trkseg>`);

const BARE = gpx(`  <trkseg>
   <trkpt lat="40.7259600" lon="-74.0013940">
    <ele>5.2</ele>
    <time>2017-05-23T12:50:43Z</time>
   </trkpt>
   <trkpt lat="40.7258970" lon="-74.0012310">
    <ele>5.4</ele>
   </trkpt>
  </trkseg>`);

describe("decodeGpx", () => {
  it("reads per-point extensions", () => {
    const activity = decodeGpx(INSTRUMENTED);
    expect(activity.records).toHaveLength(1);
    expect(activity.records[0]).toMatchObject({
      power: 227,
      cadence: 87,
      heart_rate: 146,
      temperature: 24,
    });
    expect(activity.errors).toEqual([]);
  });

  it("reads extensions whose namespace prefix is absent or unfamiliar", () => {
    const activity = decodeGpx(
      gpx(`  <trkseg>
   <trkpt lat="37.7732320" lon="-122.4589040">
    <extensions>
     <ns3:TrackPointExtension>
      <hr>141</hr>
      <ns3:cad>82</ns3:cad>
     </ns3:TrackPointExtension>
    </extensions>
   </trkpt>
  </trkseg>`),
    );
    expect(activity.records[0]).toMatchObject({ heart_rate: 141, cadence: 82 });
  });

  it("leaves telemetry null when a point carries no extensions", () => {
    const activity = decodeGpx(BARE);
    expect(activity.records[0]).toMatchObject({
      power: null,
      cadence: null,
      heart_rate: null,
      temperature: null,
      distance: null,
      speed: null,
      grade: null,
      left_right_balance: null,
      accumulated_power: null,
      gps_accuracy: null,
      developer_fields: null,
    });
  });

  it("does not let a later point's extensions bleed into an earlier one", () => {
    const activity = decodeGpx(
      gpx(`  <trkseg>
   <trkpt lat="37.7732320" lon="-122.4589040">
    <ele>86.0</ele>
   </trkpt>
   <trkpt lat="37.7733570" lon="-122.4585560">
    <ele>87.3</ele>
    <extensions>
     <power>227</power>
     <gpxtpx:TrackPointExtension>
      <gpxtpx:cad>93</gpxtpx:cad>
     </gpxtpx:TrackPointExtension>
    </extensions>
   </trkpt>
  </trkseg>`),
    );
    expect(activity.records[0]).toMatchObject({ power: null, cadence: null });
    expect(activity.records[1]).toMatchObject({ power: 227, cadence: 93 });
  });

  it("parses altitude and timestamp, leaving timestamp null when absent", () => {
    const activity = decodeGpx(BARE);
    expect(activity.records[0]?.altitude).toBe(5.2);
    expect(activity.records[0]?.timestamp).toEqual(new Date("2017-05-23T12:50:43Z"));
    expect(activity.records[1]?.altitude).toBe(5.4);
    expect(activity.records[1]?.timestamp).toBeNull();
  });

  it("parses position from the lat and lon attributes in either order", () => {
    const activity = decodeGpx(
      gpx(`  <trkseg>
   <trkpt lon="-74.0013940" lat="40.7259600"></trkpt>
  </trkseg>`),
    );
    expect(activity.records[0]).toMatchObject({
      position_lat: 40.72596,
      position_lon: -74.001394,
    });
  });

  it("increments segment across trkseg elements", () => {
    const activity = decodeGpx(
      gpx(`  <trkseg>
   <trkpt lat="40.7259600" lon="-74.0013940"/>
   <trkpt lat="40.7258970" lon="-74.0012310"/>
  </trkseg>
  <trkseg>
   <trkpt lat="40.7257000" lon="-74.0011000"/>
  </trkseg>`),
    );
    expect(activity.records.map((record) => record.segment)).toEqual([0, 0, 1]);
  });

  it("drops a null island position but keeps the rest of the record", () => {
    const activity = decodeGpx(
      gpx(`  <trkseg>
   <trkpt lat="0.0" lon="0.0">
    <ele>5.2</ele>
    <time>2017-05-23T12:50:43Z</time>
    <extensions>
     <power>180</power>
    </extensions>
   </trkpt>
  </trkseg>`),
    );
    expect(activity.records).toHaveLength(1);
    expect(activity.records[0]).toMatchObject({
      position_lat: null,
      position_lon: null,
      altitude: 5.2,
      power: 180,
      timestamp: new Date("2017-05-23T12:50:43Z"),
    });
    expect(activity.errors).toEqual([]);
  });

  it("records a point with no usable position as a non-fatal error", () => {
    const activity = decodeGpx(
      gpx(`  <trkseg>
   <trkpt><ele>5.2</ele></trkpt>
   <trkpt lat="40.7259600" lon="-74.0013940"/>
  </trkseg>`),
    );
    expect(activity.records).toHaveLength(2);
    expect(activity.records[0]).toMatchObject({
      position_lat: null,
      altitude: 5.2,
    });
    expect(activity.errors).toEqual(["trackpoint 0: no usable lat/lon"]);
  });

  it("yields no laps and no sessions", () => {
    const activity = decodeGpx(INSTRUMENTED);
    expect(activity.source).toBe("gpx");
    expect(activity.laps).toEqual([]);
    expect(activity.sessions).toEqual([]);
    expect(activity.developerFields).toEqual([]);
  });

  it("maps the gpx creator to the device product name", () => {
    expect(decodeGpx(INSTRUMENTED).device).toEqual({
      manufacturer: null,
      product: null,
      product_name: "StravaGPX",
      serial_number: null,
      software_version: null,
      hardware_version: null,
      time_created: null,
    });
  });

  it("has no device when the gpx element has no creator", () => {
    const activity = decodeGpx(
      gpx(`  <trkseg><trkpt lat="40.7259600" lon="-74.0013940"/></trkseg>`, ""),
    );
    expect(activity.device).toBeNull();
  });

  it("throws when the document has no trackpoints", () => {
    expect(() => decodeGpx(gpx(`  <trkseg></trkseg>`))).toThrow("no trackpoints");
  });

  it("reads trackpoints a writer put straight under trk with no trkseg", () => {
    // `trkseg` is minOccurs="0" in GPX 1.1, so points may sit directly under
    // `trk`. Looking only inside `trkseg` found none and threw "no
    // trackpoints", reading a perfectly good track as a trackless file.
    const activity = decodeGpx(
      gpx(`  <trkpt lat="40.7259600" lon="-74.0013940">
   <ele>5.2</ele>
   <time>2017-05-23T12:50:43Z</time>
  </trkpt>
  <trkpt lat="40.7258970" lon="-74.0012310">
   <ele>5.4</ele>
  </trkpt>`),
    );

    expect(activity.records).toHaveLength(2);
    expect(activity.errors).toEqual([]);
    expect(activity.records[0]).toMatchObject({
      position_lat: 40.72596,
      position_lon: -74.001394,
      altitude: 5.2,
      timestamp: new Date("2017-05-23T12:50:43Z"),
    });
    expect(activity.records[1]?.position_lat).toBe(40.725897);
    // The whole document stands in for the one segment nobody wrote.
    expect(activity.records.map((record) => record.segment)).toEqual([0, 0]);
  });
});

// A truncated FIT file reports its truncation in `errors`. GPX had no such
// signal: TRACK_POINT needs a closing tag, so trailing points vanished with no
// match to notice, and any point that did decode kept `records` non-empty so
// the trackless throw never fired either.
describe("decodeGpx truncation", () => {
  const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
 <trk>
  <name>Battery died</name>`;

  function truncated(body: string): Uint8Array {
    return new TextEncoder().encode(`${HEAD}\n${body}`);
  }

  it("reports the trailing points lost to a cut mid-trackpoint", () => {
    const activity = decodeGpx(
      truncated(`  <trkseg>
   <trkpt lat="40.7259600" lon="-74.0013940"><ele>5.2</ele></trkpt>
   <trkpt lat="40.7258970" lon="-74.0012310"><ele>5.4</`),
    );

    expect(activity.records).toHaveLength(1);
    expect(activity.records[0]?.position_lat).toBe(40.72596);
    expect(activity.errors).toEqual(["1 unterminated trackpoint(s), document is truncated"]);
  });

  it("reports the points lost with a segment cut after a complete one", () => {
    const activity = decodeGpx(
      truncated(`  <trkseg>
   <trkpt lat="40.7259600" lon="-74.0013940"/>
   <trkpt lat="40.7258970" lon="-74.0012310"/>
  </trkseg>
  <trkseg>
   <trkpt lat="40.7257000" lon="-74.0011000"/>
   <trkpt lat="40.7256000" lon="-74.00`),
    );

    // The complete segment matched, so the unterminated one is skipped whole:
    // the point inside it that was written in full is lost with the cut one.
    expect(activity.records.map((record) => record.position_lat)).toEqual([40.72596, 40.725897]);
    expect(activity.errors).toEqual(["2 unterminated trackpoint(s), document is truncated"]);
  });
});
