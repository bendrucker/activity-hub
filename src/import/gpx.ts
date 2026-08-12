import { emptyActivity, type TelemetryActivity } from "./telemetry";

export function decodeGpx(_bytes: Uint8Array): TelemetryActivity {
  return emptyActivity("gpx");
}
