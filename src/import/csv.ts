import { parse } from "csv-parse/sync";

export interface ExportActivity {
  sourceId: string;
  startedAt: string;
  sportType: string;
  elapsedS: number;
  filename: string | null;
  media: string[];
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const DATE_PATTERN =
  /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/;

// Export dates carry no zone marker but are UTC: verified against the first
// record timestamp of FIT files from the same archive.
export function parseExportDate(value: string): string {
  const match = DATE_PATTERN.exec(value);
  const month = match ? MONTHS[match[1] as string] : undefined;
  if (!match || month === undefined) {
    throw new Error(`unparseable activity date ${JSON.stringify(value)}`);
  }
  const [, , day, year, hour, minute, second, meridiem] = match;
  let hours = Number(hour) % 12;
  if (meridiem === "PM") {
    hours += 12;
  }
  return new Date(
    Date.UTC(
      Number(year),
      month,
      Number(day),
      hours,
      Number(minute),
      Number(second),
    ),
  ).toISOString();
}

export function parseActivitiesCsv(text: string): ExportActivity[] {
  // The export repeats column names (Elapsed Time, Distance), and the later
  // occurrences are sometimes empty where the first is populated. Keep the
  // first of each name; `false` drops a column.
  const rows = parse(text, {
    columns: (header: string[]) => {
      const seen = new Set<string>();
      return header.map((name) => {
        if (seen.has(name)) {
          return false;
        }
        seen.add(name);
        return name;
      });
    },
    skip_empty_lines: true,
  }) as Record<string, string>[];
  return rows.map((row) => ({
    sourceId: field(row, "Activity ID"),
    startedAt: parseExportDate(field(row, "Activity Date")),
    // The CSV holds display names ("Virtual Ride", "E-Bike Ride"); stripping
    // spaces and hyphens recovers the API sport_type ("VirtualRide").
    sportType: field(row, "Activity Type").replace(/[ -]/g, ""),
    elapsedS: elapsedSeconds(row),
    filename: row["Filename"] || null,
    media: (row["Media"] ?? "").split("|").filter(Boolean),
  }));
}

function field(row: Record<string, string>, name: string): string {
  const value = row[name];
  if (!value) {
    throw new Error(
      `missing ${name} in row ${JSON.stringify(row["Activity ID"] ?? row)}`,
    );
  }
  return value;
}

function elapsedSeconds(row: Record<string, string>): number {
  const value = Number.parseFloat(field(row, "Elapsed Time"));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `invalid Elapsed Time ${JSON.stringify(row["Elapsed Time"])} for activity ${row["Activity ID"]}`,
    );
  }
  return Math.round(value);
}
