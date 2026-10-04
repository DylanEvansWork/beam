import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

type Screen = 'home' | 'send' | 'receive'

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [offlineReady, setOfflineReady] = useState(false)
  const [showHow, setShowHow] = useState(false)

  useEffect(() => {
    registerSW({ onOfflineReady: () => setOfflineReady(true) })
  }, [])

  if (screen !== 'home') {
    return (
      <main className="screen">
        <button className="back" onClick={() => setScreen('home')}>
          ← Back
        </button>
        <h1>{screen === 'send' ? 'Send' : 'Receive'}</h1>
        <p className="muted">Coming soon. This is the scaffold.</p>
      </main>
    )
  }

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
        <button className="big send" onClick={() => setScreen('send')}>
          Send
        </button>
        <button className="big receive" onClick={() => setScreen('receive')}>
          Receive
        </button>
      </div>

      <footer>
        <p className="muted">
          100% on your device. No servers, no tracking, no network after load.
        </p>
        <div className="row">
          {offlineReady && <span className="badge">Works offline</span>}
          <button className="link" onClick={() => setShowHow(true)}>
            How it works
          </button>
        </div>
      </footer>

      {showHow && (
        <div className="sheet-backdrop" onClick={() => setShowHow(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>How it works</h2>
            <ol>
              <li>The sender phone's screen plays a fast stream of coloured patterns.</li>
              <li>The receiver phone's camera watches them and rebuilds the data.</li>
              <li>No wifi, bluetooth or internet needed. Just line the phones up.</li>
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
