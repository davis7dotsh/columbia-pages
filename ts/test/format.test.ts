import { describe, expect, test } from "bun:test"
import { humanSize, renderTable, truncate } from "../src/shared/format.ts"

describe("humanSize", () => {
  test("matches the Go thresholds", () => {
    expect(humanSize(42)).toBe("42B")
    expect(humanSize(2048)).toBe("2.0KB")
    expect(humanSize(1536)).toBe("1.5KB")
    expect(humanSize(3 * 1024 * 1024)).toBe("3.0MB")
  })
})

describe("truncate", () => {
  test("keeps short values and ellipsizes long ones", () => {
    expect(truncate("short", 32)).toBe("short")
    const long = "x".repeat(40)
    expect(truncate(long, 32)).toBe("x".repeat(31) + "…")
  })
})

describe("renderTable", () => {
  test("pads columns like tabwriter", () => {
    const table = renderTable([
      ["ID", "TITLE"],
      ["abc123", "hello"]
    ])
    expect(table).toBe("ID      TITLE\nabc123  hello")
  })
})
