// Themed page rendering: the exact HTML shell the Go server produces,
// including the pre-paint theme init script and the top-right toggle.

// Same escaping set as Go's html.EscapeString.
export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")

// Light/dark toggle, injected into every themed page. The init script runs in
// <head> before paint to avoid a flash: it follows the visitor's stored choice,
// or the system preference on first load. The button (top-right) flips and
// persists the choice; styling lives in theme.css (.theme-toggle).
const themeInitScript = `<script>(function(){try{var t=localStorage.getItem("cpages-theme");if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";if(t==="dark")document.documentElement.setAttribute("data-theme","dark");}catch(e){}})();</script>
`

const themeToggleButton = `<button class="theme-toggle" type="button" aria-label="Toggle light or dark theme" title="Toggle theme">
<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" stroke-width="1.4"></circle><path d="M10 2.75a7.25 7.25 0 0 1 0 14.5z" fill="currentColor"></path></svg>
</button>
`

const themeToggleScript = `<script>(function(){var root=document.documentElement,btn=document.querySelector(".theme-toggle"),mq=matchMedia("(prefers-color-scheme: dark)");function apply(t){if(t==="dark")root.setAttribute("data-theme","dark");else root.removeAttribute("data-theme");}if(btn)btn.addEventListener("click",function(){var t=root.getAttribute("data-theme")==="dark"?"light":"dark";apply(t);try{localStorage.setItem("cpages-theme",t);}catch(e){}});try{if(!localStorage.getItem("cpages-theme"))mq.addEventListener("change",function(e){apply(e.matches?"dark":"light");});}catch(e){}})();</script>
`

// renderThemed wraps body content in a full HTML document that links the house
// stylesheet. The agent only writes the content that lives inside .page.
export const renderThemed = (title: string, content: string): string =>
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/theme.css">
${themeInitScript}</head>
<body>
${themeToggleButton}<main class="page">
${content}
<footer class="columbia-pages-credit">
<a href="https://github.com/davis7dotsh/columbia-pages" target="_blank" rel="noopener noreferrer">generated on Columbia Pages</a>
</footer>
</main>
${themeToggleScript}</body>
</html>
`
