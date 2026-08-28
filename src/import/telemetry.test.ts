import { describe, expect, it } from "vitest";
import { decodeTelemetry } from "./telemetry";

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
 <trk>
  <trkseg>
   <trkpt lat="40.7259600" lon="-74.0013940"><ele>5.2</ele></trkpt>
  </trkseg>
 </trk>
</gpx>`;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("decodeTelemetry", () => {
  it("decodes a GPX file", async () => {
    const activity = await decodeTelemetry(bytes(GPX), "activities/10.gpx");
    expect(activity.source).toBe("gpx");
    expect(activity.records).toHaveLength(1);
  });

  it("unwraps a gzipped file before dispatching on the inner extension", async () => {
    const activity = await decodeTelemetry(await gzip(bytes(GPX)), "activities/10.gpx.gz");
    expect(activity.source).toBe("gpx");
  });

  // The container decides a raw key is decodable by lowering it, so an
  // uppercase extension gets accepted there and handed here. Matching exactly
  // in this function threw "unsupported telemetry file" on a file the caller
  // had already committed to, turning a bulk-export casing quirk into a failed
  // activity.
  it("matches extensions regardless of case", async () => {
    const plain = await decodeTelemetry(bytes(GPX), "activities/10.GPX");
    expect(plain.source).toBe("gpx");

    const compressed = await decodeTelemetry(await gzip(bytes(GPX)), "activities/10.GPX.GZ");
    expect(compressed.source).toBe("gpx");
  });

  it("rejects an extension it has no decoder for", async () => {
    await expect(decodeTelemetry(bytes(GPX), "activities/10.tcx")).rejects.toThrow(
      "unsupported telemetry file activities/10.tcx",
    );
  });
});
