# Broken Society

A dark, client-side P2P social network prototype with a global 48-hour live feed.

## Run

Serve this directory over HTTP (for example with `python3 -m http.server 8080`) and open the shown URL. Internet access is required for the Trystero module and public WebRTC discovery. Multiple tabs in the same browser also sync through BroadcastChannel for easy testing.

## Posting model

- Standard posts are created from Home and accept text, images, and GIFs.
- Reels have a completely separate uploader inside the Reels section and accept MP4 video only.
- Live P2P posts and reels expire from the shared network feed after 48 hours.
- A creator's own published posts and reels are also copied to a private local creator archive, so they remain visible on that creator's own profile on the same browser/device after the live window expires.
- Archived items are read-only and are not re-broadcast after expiry. Deleting an item from the creator profile removes both its live copy and local archive copy.

## P2P limitation

There is no backend. Other users cannot retrieve a creator's archived content while no browser holding a live copy is online. The permanent creator profile history is device-local unless a future backend or durable distributed storage layer is added.
