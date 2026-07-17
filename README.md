# Broken Society

Static P2P social feed for GitHub Pages.

## Included fixes

- Attachment posts render locally before network transfer.
- Media blobs are stored in IndexedDB instead of localStorage.
- Images and videos transfer separately from post metadata over Trystero.
- Each browser tab has a unique session identity for same-origin testing.
- Peer status no longer claims a connection after initialization fails.
- Profile avatar layers above the cover banner.
- Refined Broken Society SVG logo and favicon.
- `test-video.mp4` is included for browser upload testing.

## Run locally

Serve the folder over HTTP. Do not open `index.html` directly with `file://`.

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in two tabs. For real P2P testing, use the deployed HTTPS GitHub Pages URL on two devices or browsers.
