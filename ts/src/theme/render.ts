/** escapeHTML mirrors Go's html.EscapeString for text nodes/attributes. */
export const escapeHTML = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;")

// Light/dark toggle, injected into every themed page. The init script runs in
// <head> before paint to avoid a flash: it follows the visitor's stored choice,
// or the system preference on first load. The button (top-right) flips and
// persists the choice; styling lives in theme.css (.theme-toggle).
const themeInitScript =
  `<script>(function(){try{var t=localStorage.getItem("cpages-theme");if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";if(t==="dark")document.documentElement.setAttribute("data-theme","dark");}catch(e){}})();</script>\n`

const themeToggleButton =
  `<button class="theme-toggle" type="button" aria-label="Toggle light or dark theme" title="Toggle theme">\n<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" stroke-width="1.4"></circle><path d="M10 2.75a7.25 7.25 0 0 1 0 14.5z" fill="currentColor"></path></svg>\n</button>\n`

const themeToggleScript =
  `<script>(function(){var root=document.documentElement,btn=document.querySelector(".theme-toggle"),mq=matchMedia("(prefers-color-scheme: dark)");function apply(t){if(t==="dark")root.setAttribute("data-theme","dark");else root.removeAttribute("data-theme");}if(btn)btn.addEventListener("click",function(){var t=root.getAttribute("data-theme")==="dark"?"light":"dark";apply(t);try{localStorage.setItem("cpages-theme",t);}catch(e){}});try{if(!localStorage.getItem("cpages-theme"))mq.addEventListener("change",function(e){apply(e.matches?"dark":"light");});}catch(e){}})();</script>\n`

/**
 * renderThemed wraps body content in a full HTML document that links the house
 * stylesheet. The agent only writes the content that lives inside .page.
 */
export const renderThemed = (title: string, content: string): string =>
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
  '<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  "<title>" +
  escapeHTML(title) +
  "</title>\n" +
  '<link rel="stylesheet" href="/theme.css">\n' +
  themeInitScript +
  "</head>\n<body>\n" +
  themeToggleButton +
  '<main class="page">\n' +
  content +
  '\n<footer class="columbia-pages-credit">\n' +
  '<a href="https://github.com/davis7dotsh/columbia-pages" target="_blank" rel="noopener noreferrer">generated on Columbia Pages</a>\n' +
  "</footer>\n</main>\n" +
  themeToggleScript +
  "</body>\n</html>\n"
