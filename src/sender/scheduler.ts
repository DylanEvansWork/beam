/** Measure the display's real refresh interval from rAF timestamps (median of deltas; ignores outliers). */
export function measureRefresh(ticks = 60): Promise<{ intervalMs: number; hz: number }> {
  return new Promise((resolve) => {
    const stamps: number[] = []
    const step = (t: number) => {
      stamps.push(t)
      if (stamps.length < ticks) requestAnimationFrame(step)
      else {
        const d: number[] = []
        for (let i = 1; i < stamps.length; i++) d.push(stamps[i]! - stamps[i - 1]!)
        d.sort((a, b) => a - b)
        const median = d[d.length >> 1] || 16.67
        resolve({ intervalMs: median, hz: 1000 / median })
      }
    }
    requestAnimationFrame(step)
  })
}

/** Screen Wake Lock, if available. Re-acquires when the page becomes visible again. */
export class WakeLock {
  private sentinel: { release(): Promise<void> } | null = null
  private wanted = false
  private onVis = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire()
  }

  async start(): Promise<void> {
    this.wanted = true
    document.addEventListener('visibilitychange', this.onVis)
    await this.acquire()
  }

  private async acquire(): Promise<void> {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }
      if (nav.wakeLock) this.sentinel = await nav.wakeLock.request('screen')
    } catch {
      /* denied or unsupported: carry on */
    }
  }

  async stop(): Promise<void> {
    this.wanted = false
    document.removeEventListener('visibilitychange', this.onVis)
    try {
      await this.sentinel?.release()
    } catch {
      /* ignore */
    }
    this.sentinel = null
  }
}
