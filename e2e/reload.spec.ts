import { expect, type Page, test } from "@playwright/test"

function countDocumentLoads(page: Page) {
  const loads = { count: 0 }
  page.on("request", (request) => {
    if (request.resourceType() === "document" && request.frame() === page.mainFrame()) loads.count++
  })
  return loads
}

async function reloadedDocumentLoaded(page: Page) {
  await expect
    .poll(() =>
      page
        .evaluate(
          () =>
            document.readyState === "complete" &&
            (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ===
              "reload",
        )
        .catch(() => false),
    )
    .toBe(true)
}

const hashedFiles = [
  ["script", "**/assets/*.js"],
  ["stylesheet", "**/assets/*.css"],
] as const

for (const [kind, pattern] of hashedFiles) {
  test(`a page whose ${kind} is missing once reloads once and works`, async ({ page }) => {
    const loads = countDocumentLoads(page)
    let missing = true
    await page.route(pattern, async (route) => {
      if (!missing) return route.continue()
      missing = false
      await route.fulfill({ status: 404, body: "" })
    })
    await page.goto("/", { waitUntil: "commit" })
    await reloadedDocumentLoaded(page)
    await expect(page.locator("#root > *").first()).toBeVisible()
    expect(await page.evaluate(() => sessionStorage.getItem("adiutor.reloaded"))).toBeNull()
    expect(loads.count).toBe(2)
  })

  test(`a page whose ${kind} is missing every time reloads once, not again`, async ({ page }) => {
    const loads = countDocumentLoads(page)
    await page.route(pattern, (route) => route.fulfill({ status: 404, body: "" }))
    await page.goto("/", { waitUntil: "commit" })
    await reloadedDocumentLoaded(page)
    expect(await page.evaluate(() => sessionStorage.getItem("adiutor.reloaded"))).toBe("1")
    expect(loads.count).toBe(2)
  })
}
