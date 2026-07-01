import { describe, expect, test } from "bun:test"
import { escapeHtml, renderThemed } from "../src/server/render.ts"

describe("escapeHtml", () => {
  test("escapes the same characters as Go's html.EscapeString", () => {
    expect(escapeHtml(`<b>&"'</b>`)).toBe("&lt;b&gt;&amp;&#34;&#39;&lt;/b&gt;")
  })
})

describe("renderThemed", () => {
  const html = renderThemed("A & B <Report>", "<h1>Body</h1>")

  test("produces a complete document linking the house theme", () => {
    expect(html).toStartWith("<!DOCTYPE html>")
    expect(html).toContain(`<link rel="stylesheet" href="/theme.css">`)
    expect(html).toContain(`<main class="page">`)
    expect(html).toContain("<h1>Body</h1>")
  })

  test("escapes the title but not the body content", () => {
    expect(html).toContain("<title>A &amp; B &lt;Report&gt;</title>")
  })

  test("includes the theme toggle and credit footer", () => {
    expect(html).toContain(`class="theme-toggle"`)
    expect(html).toContain("generated on Columbia Pages")
    expect(html).toContain(`localStorage.getItem("cpages-theme")`)
  })
})
