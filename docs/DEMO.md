# Five-minute demo: one laptop, four phones

**Before the demo (do this ahead of time)**

- Deploy over HTTPS (see the README), or run `npm run build && npm start` plus `cloudflared tunnel --url http://localhost:3000`.
- Open `https://<your-origin>/host` on the laptop. Connect it to a projector or turn it toward the audience, and turn the volume up.
- Phones need a normal browser (Safari on iOS, Chrome on Android) and must be on the internet. They do not need the laptop's Wi-Fi.

**0:00 to 0:30: pitch**

> "Two teams. Two cars. Four phones. Half the steering is yours." Each team shares one car. One teammate can only steer left, the other can only steer right, and they steer by shaking their phone. Both roads get exactly the same traffic. First team to crash loses.

**0:30 to 1:45: join**

1. The laptop shows the lobby: QR code, a six-character room code and four seats (Blue Left, Blue Right, Orange Left, Orange Right).
2. Each volunteer scans the QR code (or types the code at `/join`), enters a short name and taps a free seat. Taken seats are greyed out, and the server rejects double-booking.
3. On the phone they tap **Enable motion** (iPhone asks for permission) and give the phone one sharp shake. The phone shows "Detected on phone", then "Server confirmed", and that player's seat flashes on the laptop. Then they tap **I'm ready**.
   - If a phone has no motion access, tap **Use touch controls instead**. The seat shows `TOUCH FALLBACK` on the laptop, and the player taps a giant arrow button instead of shaking.
   - If shakes aren't detected, raise **Sensitivity** on the phone. If they trigger too easily, lower it.
4. When all four seats show `READY`, the **Start race** button lights up.

**1:45 to 3:30: race**

1. Press **Start race**: a 3-2-1 countdown, then GO.
2. Coach the room: "The first car always blocks your starting lane. Shout at your teammate!" Each shake moves the team's car exactly one lane, with a ~150 ms slide. Shakes during a slide are ignored, so teams have to take turns.
3. Traffic speeds up over about a minute. Typical rounds last 45 to 90 seconds.
4. The first crash ends the round: an explosion, then a big **"BLUE TEAM WINS!"** overlay (or a draw if both crash in the same instant). The phones show YOU WIN / CRASHED.

**3:30 to 4:30: resilience (optional, but impressive)**

1. Press **Play again** for a rematch with fresh traffic and the same players.
2. During the race, have one player lock their phone or close the tab. The game pauses instantly on both roads, the laptop shows "*Name* disconnected, seat held for 90 s", and nothing moves.
3. They reopen the same link. The seat comes back automatically, with no re-join, and the phone asks them to re-enable controls. Press **Resume**: 3-2-1 and the race continues from exactly where it froze.

**4:30 to 5:00: wrap-up**

- Press **Back to lobby** to swap players or roles.
- Mention: authoritative Node server at 60 Hz, identical seeded traffic on both roads, a reachability check on every obstacle pattern, motion detection on the phone (no sensor streaming), and reconnection with session tokens.

**Troubleshooting during a demo**

- If the QR code points to `localhost`, open the host page through the public HTTPS URL instead, or set `PUBLIC_ORIGIN`.
- If phones only offer touch controls, the page isn't on HTTPS.
- If a phone's screen dims, keep it unlocked. The game asks for a wake lock where supported.
- Want a second screen? Open the read-only display URL shown at the bottom of the host lobby.
