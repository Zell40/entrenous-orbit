# room-images.php

Tiny same-origin companion service for the `room-gallery` Orbit plugin
(`public/plugins/third/orbit-room-gallery.js`). Lets a channel's founder
attach a picture to their channel. The picture's **URL storage** stays
outside of IRC entirely — nothing ever appears in the topic, and other IRC
clients (KiwiIRC, irssi, …) never see a trace of *that*. The plugin's gallery,
the channel topbar, the sidebar's list of open rooms, and the channel-admin
picture picker all read this endpoint to show the picture. Setting or
clearing a picture separately posts a normal `/me` line in the channel
itself announcing the change (with the image inline) — that part **does**
travel over IRC like any other message, on purpose, so members notice.

This whole feature (gallery + pictures) lives in the plugin file and this
server script — **no Orbit core file is modified**, so updating/reinstalling
Orbit never touches or conflicts with it. See the top comment in
`orbit-room-gallery.js` for how it swaps itself in for the native "Explorer
les salons" window without patching it.

## How it works

1. A founder opens "Gérer mon chan" → Aperçu and clicks "Choisir une image"
   under "Image du salon" (just below "Accès & mot de passe") — shown only
   when the plugin sees them holding the founder mode client-side; this is
   just UI gating, the real check is step 3.
2. Orbit asks the ircd for an `EXTJWT #channel` token (channel-scoped, not the
   network-wide `EXTJWT *`). The ircd signs a JWT that includes the requester's
   current channel modes (`cmodes`) — cryptographic proof of founder status
   that this script can verify without ever talking to the ircd itself.
3. Orbit `POST`s the picked file (as `multipart/form-data`, field `file`) to
   this script with `Authorization: Bearer <jwt>`. The script verifies the
   signature, checks the channel in the token matches, checks the founder
   mode letter is present in `cmodes`, then saves the file itself into
   `room-images-uploads/` (next to this script) under a random name and
   stores the resulting URL in `room-images.json`.
   - This deliberately does **not** go through Orbit's core `/FILEHOST` →
     `/upload` pipeline (the one behind the chat composer's image button):
     that pipeline expects an operator-run IRC bot that answers a raw
     `FILEHOST` command with a NOTICE token — most ircds (plain InspIRCd,
     UnrealIRCd without such a bot, …) don't have one, so it just times out.
     This script is fully self-contained instead.
   - To clear a picture (the "Retirer" button), Orbit instead sends a plain
     JSON body `{ "url": null }` with the same `Authorization` header.
   - The returned/stored `url` is always absolute (scheme + host, auto-
     detected from the request — same `detect_origin()` approach as
     `server/filehost/filehost-upload.php`), never just a path: it's reused
     as-is both for the CSS `background-image` tiles (which wouldn't care
     either way) AND for the `/me` announcement's plain-text URL, which only
     renders as an inline image for everyone if it's a full `https?://…` link
     (see `src/lib/format.tsx`).
   - Channel names are matched **case-insensitively**: this script lowercases
     every channel name before using it as a key (`canon_channel()`), and the
     plugin does the same on every lookup. IRC channel names are
     case-insensitive, but the exact case Orbit's buffer shows for one isn't
     guaranteed to match the case a LIST reply reports for it — without this,
     a picture could be saved successfully yet never appear anywhere.
4. Everyone's Orbit client reads the whole map with a plain `GET` (public,
   no auth, `Cache-Control: no-store`) to populate the plugin's gallery
   grid/list, the topbar, and the sidebar.

## Deploy

1. Copy `room-images.php` to a path reachable under the **same origin** Orbit
   is served from, so the plugin's `fetch()` calls need no CORS configuration.
   Make sure the containing directory is writable by PHP —
   `room-images.json` and the `room-images-uploads/` directory are both
   created automatically on first write.
2. Create a **sibling** `room-images.local.php` next to it (same directory,
   never touched by `deploy.sh`, not tracked by git — `.gitignore` already
   has `*.local.php`) with:
   ```php
   <?php
   $EXTJWT_SECRET = 'the-real-secret'; // must exactly match the `secret` in
                                        // your ircd's `extjwt { … }` block
                                        // (same value kiwiirc-plugin-
                                        // fileuploader's [JwtSecretsByIssuer]
                                        // uses, if you have one)
   $FOUNDER_CMODE = 'q'; // founder channel-mode LETTER (not display prefix
                          // `~`!) — check ISUPPORT's PREFIX token, e.g.
                          // "PREFIX=(qaohv)~&@%+" → letter for `~` is 'q'
   ```
   `deploy.sh` always overwrites `room-images.php` itself with the latest
   code from git on every deploy (so fixes land automatically) — putting
   secrets in this separate, git-ignored file instead of editing
   `room-images.php` directly means that overwrite never wipes them.
3. In `public/plugins/third/orbit-room-gallery.js`, set `ROOM_IMAGES_ENDPOINT`
   to wherever you deployed this script (default: `/room-images.php`).
4. If step 1 can't be same-origin, uncomment and adjust the
   `Access-Control-Allow-*` headers near the top of `room-images.php`.
5. `deploy.sh` already excludes `room-images.json` and
   `room-images-uploads/` from its mirror step, so redeploying the app never
   wipes previously uploaded pictures — if you use a different deploy
   process, make sure it does the same.

## Notes

- If your ircd doesn't have the `extjwt` module/block enabled at all, the
  plugin will surface a "server doesn't support this" error when a founder
  tries to set a picture — enable it first.
- `room-images.json` now lives **inside** `room-images-uploads/` (not next to
  the PHP script in the web root). The web root is often not writable by
  `www-data`, which used to make uploads look successful (file saved, URL
  returned, `/me` showed the image) while the map stayed empty forever —
  gallery/topbar/sidebar then had nothing to display. The uploads directory
  is already required to be writable. A leftover map at the old web-root
  path is migrated automatically on the next read.
- Uploaded pictures are capped at 8MB and must be jpg/png/gif/webp
  (`$MAX_UPLOAD_BYTES` / `$ALLOWED_UPLOAD_MIME` in the script). Make sure
  your `php.ini`'s `upload_max_filesize` and `post_max_size` are both at
  least `8M`, otherwise PHP silently drops the upload before this script
  ever runs (surfaces to the founder as a generic "upload failed").
- A "save_failed" error (500) is almost always a filesystem permissions
  mismatch between the web server's user (e.g. `www-data`) and whoever owns
  the web root — see `server/filehost/README.md`'s "Troubleshooting:
  500: save_failed" section, which applies here identically (the real error
  gets logged to Apache's error log, never sent to the client). If you
  already fixed `room-images-uploads/` but still see empty pictures
  everywhere, re-set the picture once from "Gérer mon chan" after deploying
  this version — earlier uploads may have left the image file on disk
  without ever writing the channel→url map.
