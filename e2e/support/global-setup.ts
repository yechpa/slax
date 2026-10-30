/** Waits until the stack answers (PHP-FPM, Reverb and the queue start in parallel with the run). */
export default async function globalSetup(): Promise<void> {
  const deadline = Date.now() + 90_000
  let last = 'no answer'
  while (Date.now() < deadline) {
    try {
      const [health, spa] = await Promise.all([fetch('http://localhost/api/v1/health'), fetch('http://localhost/')])
      if (health.ok && spa.ok) return
      last = `health ${health.status}, spa ${spa.status}`
    } catch (error) {
      last = String(error)
    }
    // Readiness polling before any test runs (tests themselves never sleep).
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`The e2e stack did not come up at http://localhost (${last}).`)
}
