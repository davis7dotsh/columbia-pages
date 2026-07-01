// Presentation helpers matching the Go CLI's output formats.

const pad2 = (n: number) => String(n).padStart(2, "0")

// "2006-01-02 15:04" in local time.
export const formatLocalMinute = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// RFC 3339 in local time, e.g. "2026-07-01T12:00:00+02:00".
export const formatLocalRfc3339 = (iso: string): string => {
  const d = new Date(iso)
  const offsetMinutes = -d.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMinutes)
  const zone =
    abs === 0 ? "Z" : `${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${zone}`
  )
}

export const humanSize = (n: number): string => {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)}MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)}KB`
  return `${n}B`
}

export const truncate = (value: string, max: number): string => {
  const chars = Array.from(value)
  if (chars.length <= max) return value
  return chars.slice(0, max - 1).join("") + "…"
}

// Minimal equivalent of Go's tabwriter for the `list` table: columns are
// padded to the widest cell plus two spaces.
export const renderTable = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths: Array<number> = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
    )
    .join("\n")
}
