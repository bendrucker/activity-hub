import { emptyActivity, type TelemetryActivity } from "./telemetry";

export function decodeFit(_bytes: Uint8Array): TelemetryActivity {
  return emptyActivity("fit");
}
