# Mirror — screen mirroring to a Samsung TV from your browser

Mirror a Chrome tab (picture **and** sound) from your computer to a Samsung Smart TV, using only the browsers on both sides. No app to install on the TV, and the server has **zero npm dependencies**.

It is a proof of concept. It has two modes:

| Mode | Mac page | TV page | Delay | Smoothness |
|---|---|---|---|---|
| **Buffered stream (recommended)** | `/stream` | `/tvstream` | ~2 s | Smooth, picture and sound in sync |
| WebRTC | `/` | `/tv` | < 1 s | Can stutter and drift out of sync on TVs |

## Why two modes?

WebRTC was the first attempt. On a Tizen 9 TV it decoded every frame but dropped many of them, and the video fell behind the audio. TV browsers are not tuned for WebRTC video.

The buffered stream avoids this. The computer records the tab as H.264 + AAC (hardware-encoded), sends small chunks over plain HTTP, and the TV plays them with Media Source Extensions. That is the TV's native player, which buffers and keeps audio and video in sync. If you don't mind about 2 seconds of delay, use this mode.

The WebRTC mode is kept for comparison and for cases where low delay matters more than smoothness.

## Requirements

- Node.js 18 or newer (tested on Node 26)
- Google Chrome on the computer that shares the screen (the sharing page needs Chrome's tab-audio capture)
- A Samsung Smart TV with a web browser (tested on Tizen 9)
- The computer and the TV on the same network

## Quick start

```bash
node server.js
```

The server prints the addresses to use:

```
Buffered stream (smooth, recommended):
  Mac: http://localhost:3000/stream
  TV:  http://192.168.1.20:3000/tvstream

WebRTC (low delay):
  Mac: http://localhost:3000/
  TV:  http://192.168.1.20:3000/tv
```

1. On the TV, open the **Internet** app and go to the `TV:` address.
2. On the computer, open the `Mac:` address in Chrome. Use `localhost`, not the IP address: Chrome only allows screen capture on `localhost` or HTTPS.
3. Choose a quality and click **Start**.
4. Choose a **Chrome Tab** and turn on **"Also share tab audio"**.
5. On the TV remote, press **OK**. The first press turns on sound and full screen. Later presses switch full screen on and off.

To use another port: `PORT=8080 node server.js`.

## Using it

**Quality:** 480p, 720p or 1080p. Changing it restarts the stream, so expect about 2 seconds of buffering. 1080p uses about 8 Mbps. If it stutters, check the stats below, then try 720p.

**Format:** "auto" is right for most cases. It picks the first format that both Chrome and the TV support, in this order: H.264 High, H.264 Main, H.264 Baseline, VP9, VP8. You can force a format from the dropdown.

**Sound:** Chrome can only capture sound from a **tab**. Share a tab with "Also share tab audio" on. That tab's sound then plays on the TV only and is muted on the computer. If you share the entire screen or a window, the page warns you: either no sound is captured, or it also keeps playing on the computer. Capturing the whole computer's system audio is not possible from a web page.

**Stats:** the Mac page shows two lines that help with troubleshooting.

```
MAC → 1280×720 @ 30fps, 4800 kbps, audio: tab audio
TV  ← 1280×720, playing, buffer ahead 2.0s, dropped 0/900 frames, stalls 0
```

- *buffer ahead* near 0 and *stalls* going up: the network is too slow. Lower the quality or use a better Wi-Fi connection.
- *dropped* frames going up: the TV can't keep up. Lower the quality.

## How it works

```
 Computer (Chrome)                    server.js                   TV (browser)
 ─────────────────                    ─────────                   ────────────
 getDisplayMedia (tab + audio)
 MediaRecorder: H.264 + AAC
   chunk every 250 ms  ──POST /media/chunk──►  keeps last ~60 s
                                               ◄──GET /media/chunk (long-poll)──  MSE SourceBuffer
                                                                                  <video> hardware player
 control messages  ◄───── Server-Sent Events + POST /signal ─────►  control messages
```

- **Chunks:** chunk 0 holds the container header and is always kept, so a TV that connects late can start from the beginning of the session. Older chunks are dropped after about 60 seconds.
- **Sessions:** each Start, quality change or TV reconnect begins a new session with a fresh header. A TV that falls too far behind gets `410 Gone` and asks for a new session.
- **Pacing:** the TV starts playing after 1.5 s is buffered and tries to stay about 2 s behind live. If it falls behind it plays at 1.05× speed. If it is more than 10 s behind it jumps ahead. Played data older than 15 s is removed to save TV memory.
- **Silent tabs:** the TV player expects an audio track, so when a tab has no audio, the sender adds a silent one.
- **TV compatibility:** the TV page checks which formats it supports and tells the computer, so the computer never records something the TV can't play.

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP server: serves the pages, relays control messages, stores and serves the media chunks |
| `public/stream-sender.html` | Buffered stream, computer side: capture, record, upload |
| `public/stream-tv.html` | Buffered stream, TV side: download, play, full screen, stats |
| `public/sender.html` | WebRTC, computer side |
| `public/tv.html` | WebRTC, TV side. Sound mode can be changed in the address, e.g. `/tv?audio=webaudio` (`element`, `webaudio`, `video`, `off`) |

## Security

This is a demo for a trusted home network.

- There is **no authentication and no encryption**. Anyone on the same network who knows the address can open `/tvstream` and watch what you share, or open the sender page and send their own screen to your TV.
- Don't run it on a public or shared network, and don't expose the port to the internet.
- Stop the server when you are not using it.

## Known limits

- Sound comes from one Chrome tab, not the whole computer.
- The buffered stream adds about 2 seconds of delay, so it is not suitable for games or live interaction.
- The TV page needs the TV's browser to be open and in the foreground.
- One sender and one TV at a time.
- Tested on: macOS, Chrome 157, Samsung Tizen 9. Other TVs and browsers may behave differently.

## Ideas for next steps

- A pairing code so only your own devices can connect
- HTTPS
- A native macOS sender (ScreenCaptureKit) to capture full system audio
- A packaged Tizen TV app, so the browser bar is gone and it starts on its own
- Multiple TVs

## License

MIT, see [LICENSE](LICENSE).
