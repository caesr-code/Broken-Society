# Broken Society

A dark, professional X-style social feed built as a static client-side app.

## Run

Because the app uses ES modules and WebRTC, serve the folder over HTTP rather than opening `index.html` directly.

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## P2P behaviour

- Joins the global Trystero room `global-48h-feed`
- Broadcasts post and social mutations to live peers
- Uses BroadcastChannel as a same-browser/tab fallback for local testing
- Keeps data in each browser's localStorage
- Removes posts after 48 hours
- Reconciles snapshots when peers connect
- Recovers shared posts with `#post/XXXXXXXX` links while a peer holding the post is online

## Notes

There is intentionally no backend. Media is stored as browser data URLs, so keep uploads small. Very large peer rooms will naturally be constrained by browser-to-browser replication and WebRTC mesh limits.
