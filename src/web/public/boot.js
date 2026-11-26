;(() => {
  try {
    const theme = localStorage.getItem("adiutor.theme") || "system"
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.classList.toggle("dark", dark)
    const lang = localStorage.getItem("adiutor.language") === "en" ? "en" : "he"
    document.documentElement.lang = lang
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr"
    if (localStorage.getItem("adiutor.nav") === "rail") document.documentElement.dataset.nav = "rail"
  } catch {
    // Private mode or storage blocked: the defaults (light, Hebrew) stay.
  }
})()
;(() => {
  const marker = "adiutor.reloaded"
  let failed = false
  const isHashedFile = (element) => {
    const address =
      element instanceof HTMLScriptElement
        ? element.src
        : element instanceof HTMLLinkElement && element.rel === "stylesheet"
          ? element.href
          : ""
    if (!address) return false
    const url = new URL(address)
    return url.origin === location.origin && url.pathname.startsWith("/assets/")
  }
  addEventListener(
    "error",
    (event) => {
      if (!isHashedFile(event.target)) return
      failed = true
      try {
        if (sessionStorage.getItem(marker) !== null) return
        sessionStorage.setItem(marker, "1")
      } catch {
        return
      }
      location.reload()
    },
    true,
  )
  addEventListener("load", () => {
    if (failed) return
    try {
      sessionStorage.removeItem(marker)
    } catch {}
  })
})()
