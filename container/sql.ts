// The lake build assembles its queries as text, because the sources are URIs
// rather than bound values and DuckDB takes no parameter in a read_parquet or
// a secret definition. These two are what keep an identifier or a path with a
// quote in it from ending the token it sits in.

export function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
