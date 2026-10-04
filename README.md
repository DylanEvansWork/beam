# Beam

Send text and files from one phone to another using only a screen and a camera. No wifi, no bluetooth, no internet, no server. Everything runs in the browser, and it works offline once loaded.

Status: early development (milestone 1 of 9: scaffold). See `CLAUDE.md` for the design constraints and `DECISIONS.md` for why things are the way they are.

## Roadmap
1. Scaffold + deploy
2. Engine core (GF256, Reed-Solomon, fountain code, packets)
3. Framing + renderer
4. Channel simulator + loopback decoder
5. Browser camera pipeline
6. Full app flow
7. Real-device tuning
8. Link Test mode
9. Polish + offline hardening

## Develop
```bash
npm install
npm run dev        # local dev server
npm test           # unit tests
npm run build      # static build to dist/
```

## Deploy
Static Vite project: import the GitHub repo into Vercel, build command `npm run build`, output `dist`. No special headers needed.

## Install on a phone
Open the site in Safari, tap Share, then Add to Home Screen. After the first load it works in airplane mode.
