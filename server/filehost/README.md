# filehost-upload.php

Same-origin `/upload` endpoint for Orbit's **own, built-in** image/voice
sharing (the composer's image button + voice recorder — see
`src/core/store/upload.ts`). This is a completely different feature from the
`room-gallery` plugin's `room-images.php` (channel pictures) — this one
powers the ordinary "share an image/voice note in chat" flow that ships with
Orbit itself.

## Why Orbit's upload silently times out without this

Orbit's client does exactly two things whenever someone attaches an image or
records a voice note:

1. Sends the raw IRC command `FILEHOST`, and waits for a `NOTICE` back that
   contains a `token=...` parameter.
2. POSTs the file to **its own origin's literal `/upload?token=...`** path
   (always relative — it ignores whatever base URL an ircd module might
   advertise for file hosting).

Neither of these is a normal ircd feature — an ircd with no matching module
has no idea what `FILEHOST` means and never replies, so step 1 just times
out. That's the same "délai dépassé" you'd see on any network that hasn't
set this up.

To make it work, TWO pieces are needed:

- **On the ircd**: a module that answers `/FILEHOST` with a NOTICE
  containing a token — see the "ircd side" section below for the exact one
  this deployment uses (a custom InspIRCd v4 module, `ircv3_filehost`).
- **On the web side**: this script, which verifies that JWT and actually
  stores the file — that's step 2 above.

## ircd side: the `ircv3_filehost` InspIRCd v4 module

This is a **custom, self-compiled** module (`m_ircv3_filehost.so`,
`$ModAuthor: reverse`, `$ModDepends: core 4`) — it is not part of InspIRCd
core or the official `inspircd-contrib` repository, so it has to be compiled
from source and dropped into InspIRCd's `src/modules/` before `make install`.
It links against `jwt-cpp` (`$LinkerFlags: -lcrypto -lssl`).

Once compiled and loaded (`<module name="ircv3_filehost">`), configure it
with a `<filehost>` block:

```
<module name="ircv3_filehost">
<filehost website="https://your-webchat-domain.example"
          jwt_secret="a-long-random-secret-different-from-extjwt"
          jwt_issuer="FILEHOST"
          token_expiry="3600"
          requiressl="yes"
          auth_message="Identifie-toi avec /msg NickServ IDENTIFY <mot de passe> pour envoyer des fichiers">
```

| Attribute | Meaning |
| --- | --- |
| `website` | Base URL used to build the NOTICE text (`<website>/upload?token=...`, `<website>/files/<name>`) and to recognize/tag `<website>/files/...` links pasted in messages (`OnUserPreMessage`), plus gate the `requiressl` check below. **Set it to the same origin the webchat itself is served from** (where `filehost-upload.php` is deployed) — no trailing slash. Orbit's own upload flow doesn't actually read this value (see below), but the module's own link-tagging/SSL-gating logic does. |
| `jwt_secret` | HS256 signing secret. Can be the same as `ircv3_extjwt`'s secret or a different one — this module only has to agree with `$JWT_SECRET` in `filehost-upload.php`, nothing else. |
| `jwt_issuer` | Embedded as the JWT's `iss` claim (default `FILEHOST`). Must match `$JWT_ISSUER` in `filehost-upload.php`. |
| `token_expiry` | Token lifetime in seconds, `60`–`86400` (default `3600` = 1h). |
| `requiressl` | If `yes` (default), denies a message containing `website` sent by a user on a non-TLS connection. Unrelated to whether the upload itself succeeds. |
| `auth_message` | Shown after "*** You must be logged in to use file hosting." when a non-identified user runs `/FILEHOST`. |

The module signs the JWT with `sub` = the user's **current nick** (not their
account name) — `filehost-upload.php` never checks `sub` anyway, only the
signature/issuer/expiry, so this doesn't matter operationally.

## Important: this script doesn't need `website` to be correct

Orbit's client **always** POSTs to its own origin's relative `/upload` — it
never reads or follows the URL embedded in the NOTICE text, it just regexes
out the `token=` value. So even if `website` above ends up wrong, unset, or
unreachable, uploads through Orbit's composer still work; only the module's
own cosmetic NOTICE wording and its unrelated link-tagging feature would be
affected. The only two values that actually have to match anything are
`jwt_secret` / `jwt_issuer` ↔ `filehost-upload.php`'s `$JWT_SECRET` /
`$JWT_ISSUER`.

## Important: the returned `url` MUST be absolute

Unlike `website` above, `$PUBLIC_ORIGIN`/`$PUBLIC_URL_PATH` in
`filehost-upload.php` genuinely matter: the JSON `url` this script hands
back to Orbit gets shared as chat text (`📷 partage une image : <url>`), and
Orbit's own message renderer (`src/lib/format.tsx`) only turns
`https?://...` runs into an inline `<img>`/`<audio>` card — a bare path like
`/files/x.png` is shown as plain, unclickable text to *everyone*, sender
included (this was a real bug: uploads "succeeded" but never rendered).
`$PUBLIC_ORIGIN` is auto-detected from the request by default (honouring
`X-Forwarded-Proto`/`X-Forwarded-Host` behind a reverse proxy) — only set it
explicitly if that guess is ever wrong for your setup.

## Deploy (Apache2)

1. **ircd side** — compile the module into InspIRCd (`src/modules/`,
   `make`, `make install`), add the `<filehost>` block above, `/REHASH`.
2. **Web side** — copy `filehost-upload.php` to your web root (stays at the
   site root — unrelated to the gallery plugin under
   `plugins/third/orbit-room-gallery/`). Make sure the directory is writable
   by PHP so it can create `files/` (matches the module's own
   `<website>/files/<name>` assumption above).
3. Create a sibling `filehost-upload.local.php` (same directory, git-ignored,
   never touched by `deploy.sh` — see `plugins/orbit-room-gallery/README.md`
   for the same pattern) with:
   ```php
   <?php
   $JWT_SECRET = 'a-long-random-secret-different-from-extjwt'; // same as <filehost jwt_secret="...">
   $JWT_ISSUER = 'FILEHOST';                                    // same as <filehost jwt_issuer="...">
   ```
4. Apache needs to route `/upload` (and `/app/upload` when the SPA is
   under `Alias /app → WEBROOT`) to this script — that rewrite ships in
   `config/.htaccess` and is copied to WEBROOT by `deploy.sh`.
   **Use a relative rewrite target** (`filehost-upload.php`, no leading
   slash). A leading slash is resolved against the vhost DocumentRoot,
   which is *not* WEBROOT under Alias, and produces a silent 404 even
   though the PHP file is present. Set `$PUBLIC_URL_PATH = '/app/files'`
   in `filehost-upload.local.php` for the same layout.
   - `.htaccess` rules are silently ignored unless your Apache vhost has
     `AllowOverride All` (or at least `AllowOverride FileInfo`) for the web
     root directory, and `mod_rewrite` is enabled (`a2enmod rewrite`). If
     `/upload` still comes back as a plain 404 HTML page instead of JSON
     after deploying, that's the most likely cause — check your vhost's
     `<Directory>` block for the web root.
   - If you'd rather not rely on `.htaccess` at all, move the same
     `RewriteEngine On` / `RewriteRule` lines into your vhost's own
     `<Directory>` block instead — functionally identical, just centrally
     configured.
5. Make sure PHP's `upload_max_filesize` and `post_max_size` are both
   at least `16M`. `deploy.sh` copies `server/filehost/.user.ini` to
   WEBROOT for PHP-FPM (and `config/.htaccess` sets the same for mod_php).
   Without that, PHP silently drops the body and this script returns
   `400:upload_failed` / `no_file` / `post_too_large`. After deploy, wait
   for FPM's `user_ini.cache_ttl` (~5 min) or reload php-fpm.
6. `deploy.sh` already excludes `filehost-upload.php` and its `files/`
   directory from its mirror step, so redeploying the app never wipes
   uploaded files or this config — if you use a different deploy process,
   do the same.

## Troubleshooting: "500: save_failed"

This means PHP itself couldn't create `files/` or write the uploaded file
into it — almost always a **permissions mismatch** between the user your web
server runs as (commonly `www-data` on Debian/Ubuntu Apache) and whoever owns
the web root (here, `chat`, deployed by `deploy.sh` which never uses `sudo`).
`chat` creating/owning the directory doesn't automatically mean `www-data`
can write into it.

1. **Check the real reason** in Apache's PHP error log (this script logs the
   exact OS-level error there, never to the client):
   ```
   sudo tail -n 20 /var/log/apache2/error.log
   ```
   Look for a line starting with `filehost-upload: mkdir(...)` or
   `filehost-upload: move_uploaded_file(...)`.
2. **Fix it** — whoever has root needs to let the web server's user write to
   the upload directory. The most robust fix is adding that user to a group
   `chat` also belongs to (or vice versa) and using the group-write bit:
   ```
   sudo usermod -aG chat www-data          # one-time, needs root
   sudo chgrp chat /home/chat/irc/webchat-new   # or chgrp www-data, either direction works
   sudo systemctl restart apache2          # group membership needs a fresh process
   ```
   Then, as `chat` (no sudo needed), make the specific upload directories
   group-writable so new files/dirs created by either user work for both:
   ```
   mkdir -p /home/chat/irc/webchat-new/files \
            /home/chat/irc/webchat-new/plugins/third/orbit-room-gallery/room-images-uploads
   chmod 2775 /home/chat/irc/webchat-new/files \
              /home/chat/irc/webchat-new/plugins/third/orbit-room-gallery/room-images-uploads
   ```
   (`2775` = the setgid bit, so files created later by `www-data` keep the
   `chat` group too, and vice versa.)
   - If you don't have root access to run the `usermod`/`chgrp` step, the
     pragmatic (less strict, but sudo-free) fallback is making just those two
     directories world-writable instead: `chmod 777` on the same two paths
     above — fine for a small deployment, just be aware anyone with shell
     access on the box could write there too.
3. Re-test the upload — no redeploy needed, this is a filesystem permissions
   change only.

## Notes

- Allowed types: jpg/png/gif/webp images and webm/ogg/m4a voice notes
  (`$ALLOWED_UPLOAD_MIME` — extend it if you need more; the ircd module's
  own `/FILEHOST info` text advertises a broader list — txt/pdf/html/css/js —
  but this script deliberately doesn't accept those: hosting arbitrary HTML/
  JS/CSS on the same origin as the webchat would be a same-origin XSS risk).
- Files are named with a random 32-hex-char id, never the original filename
  (avoids collisions and leaking local filesystem info).
- The first time a file is saved, this script drops a small `.htaccess`
  inside `files/` disabling directory listing and PHP execution there, as
  defense in depth on top of the mime/extension allowlist above.
- This script never deletes old files — add your own cleanup/retention job
  against `files/` if storage growth matters to you.
