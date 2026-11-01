// Runs before the first paint (index.html loads it synchronously): applies the theme and the
// language this browser last used, so the page never flashes in the wrong theme or direction.
// Kept as a file rather than inline so the Content-Security-Policy can forbid inline scripts.
;(() => {
  try {
    const theme = localStorage.getItem("mikud.theme") || "system"
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.classList.toggle("dark", dark)
    const lang = localStorage.getItem("mikud.language") === "en" ? "en" : "he"
    document.documentElement.lang = lang
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr"
  } catch {
    // Private mode or storage blocked: the defaults (light, Hebrew) stay.
  }
})()
