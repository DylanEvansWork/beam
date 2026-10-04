import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import LinkTest from './ui/LinkTest'
import Loopback from './ui/Loopback'
import Receive from './ui/Receive'
import Send from './ui/Send'

type Route = 'home' | 'send' | 'receive' | 'linktest' | 'loopback'

const parse = (): Route => {
  const h = location.hash.replace(/^#\/?/, '')
  return (['send', 'receive', 'linktest', 'loopback'] as const).find((r) => r === h) ?? 'home'
}

/** Drop the service worker and every cache, then reload: guarantees the newest build from the network. */
async function forceUpdate() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map((r) => r.unregister()))
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
  } catch {
    /* reload anyway */
  }
  location.reload()
}

export default function App() {
  const [route, setRoute] = useState<Route>(parse())
  const [offlineReady, setOfflineReady] = useState(false)
  const [updateReady, setUpdateReady] = useState<null | (() => void)>(null)
  const [showHow, setShowHow] = useState(false)

  useEffect(() => {
    const onHash = () => setRoute(parse())
    window.addEventListener('hashchange', onHash)
    let timer = 0
    const check = (r?: ServiceWorkerRegistration) => void r?.update().catch(() => {})
    let reg: ServiceWorkerRegistration | undefined
    const update = registerSW({
      onOfflineReady: () => setOfflineReady(true),
      onNeedRefresh: () => setUpdateReady(() => () => void update(true)),
      onRegisteredSW: (_url, r) => {
        reg = r
        check(r)
        timer = window.setInterval(() => check(r), 60_000)
      },
    })
    const onVis = () => document.visibilityState === 'visible' && check(reg)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('hashchange', onHash)
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(timer)
    }
  }, [])

  const go = (r: Route) => {
    location.hash = r === 'home' ? '' : `/${r}`
    setRoute(r)
  }

  if (route === 'send') return <Send onBack={() => go('home')} />
  if (route === 'receive') return <Receive onBack={() => go('home')} />
  if (route === 'linktest') return <LinkTest onBack={() => go('home')} />
  if (route === 'loopback') return <Loopback onBack={() => go('home')} />

  return (
    <main className="screen home">
      <header>
        <div className="logo" aria-hidden>
          <i /> <i /> <i /> <i />
        </div>
        <h1>Beam</h1>
        <p className="tagline">Phone to phone. Just a screen and a camera.</p>
      </header>

      <div className="actions">
        <button className="big send" onClick={() => go('send')}>
          Send
        </button>
        <button className="big receive" onClick={() => go('receive')}>
          Receive
        </button>
        <div className="row center">
          <button className="link" onClick={() => go('linktest')}>
            Link test
          </button>
          <button className="link" onClick={() => go('loopback')}>
            Loopback demo
          </button>
        </div>
      </div>

      <footer>
        <p className="muted">100% on your device. No servers, no tracking, no network after load.</p>
        <div className="row">
          {offlineReady && <span className="badge">Works offline</span>}
          {updateReady && (
            <button className="link" onClick={updateReady}>
              Update available: reload
            </button>
          )}
          <button className="link" onClick={() => setShowHow(true)}>
            How it works
          </button>
        </div>
        <div className="row">
          <span className="build">build {__BUILD_ID__}</span>
          <button className="link small" onClick={forceUpdate}>
            Force update
          </button>
        </div>
      </footer>

      {showHow && (
        <div className="sheet-backdrop" onClick={() => setShowHow(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>How it works</h2>
            <ol>
              <li>The sender's screen plays a fast stream of coloured patterns.</li>
              <li>The receiver's camera watches them and rebuilds the file.</li>
              <li>No wifi, bluetooth or internet. Just line the phones up.</li>
            </ol>
            <button className="big" onClick={() => setShowHow(false)}>
              Got it
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
