# Third-party notices

ClipVault's own code is MIT licensed (see `LICENSE`). It ships with, or downloads, the components below, each under its own license.

> **DRAFT: check before publishing.** This was drafted from the files in the repo on 2026-10-29. It isn't legal advice. The FFmpeg section matters most: read "What the GPL asks of you" before you upload a release that bundles `ffmpeg.exe`.

## FFmpeg: GPL version 3

- **What:** `bin\ffmpeg.exe` and `bin\ffprobe.exe`, which do all capture and encoding. ClipVault runs them as separate programs; it doesn't link to FFmpeg's libraries.
- **Build:** `ffmpeg version 9.0.2-essentials_build-www.gyan.dev` (built with gcc 16.2.0, MSYS2). It's downloaded by `setup.js` from `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`.
- **Configuration** (from `ffmpeg -version`): `--enable-gpl --enable-version3 --enable-static`. It includes libx264, libx265 and libxvid (GPL), plus NVENC/AMF/QSV (libvpl), libvpx, libaom, libopus, libmp3lame, libass and others. Because of `--enable-gpl --enable-version3`, **this build as a whole is licensed under the GNU General Public License, version 3**.
- **License text:** https://www.gnu.org/licenses/gpl-3.0.html. The FFmpeg project's licensing page is https://ffmpeg.org/legal.html.
- **Source code:**
  - FFmpeg 9.0.2: https://ffmpeg.org/releases/ (`ffmpeg-9.0.2.tar.xz`) and https://git.ffmpeg.org/ffmpeg.git (tag `n9.0.2`).
  - The build's own source and configuration: https://www.gyan.dev/ffmpeg/builds/ (the "release essentials" build and its linked git sources).
- FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

### What the GPL asks of you when a release bundles ffmpeg.exe

ClipVault only *runs* FFmpeg as a separate process, so ClipVault itself can stay MIT. But distributing `ffmpeg.exe` inside your zip or installer means distributing GPL software. In practice:
1. Ship the GPLv3 license text with it, e.g. `licenses\FFmpeg-GPL-3.0.txt` next to `ffmpeg.exe`, plus this notice file.
2. Make the **corresponding source** available. The usual ways:
   - **(a)** attach the FFmpeg 9.0.2 source tarball (and gyan.dev's build scripts/config) to the same GitHub release; or
   - **(b)** include a written offer, valid for 3 years, to provide it.

   A plain link to someone else's server is widely used but is the weakest option; (a) is the safest and costs one upload.
3. Don't add restrictions: no "no reverse engineering" terms that cover `ffmpeg.exe`.

Alternative: ship an **LGPL** FFmpeg build (no `--enable-gpl`). That build has no libx264/libx265, so the CPU fallback encoder would be lost; NVENC/AMF/QSV still work.

## Electron, Chromium and Node.js

- **Electron**: MIT License, © GitHub Inc. and Electron contributors. https://github.com/electron/electron/blob/main/LICENSE
- Electron bundles **Chromium** (BSD-style and many others) and **Node.js** (MIT). Their full notices are in `LICENSES.chromium.html`, which comes with every Electron build. Keep it in the packaged app (electron-builder does so by default).

## Manrope font: SIL Open Font License 1.1

- `src/renderer/fonts/Manrope-*.ttf`, © The Manrope Project Authors. The license is `src/renderer/fonts/OFL.txt`, included in the repo.

## Lucide icons: ISC License

- The interface icons in `src/renderer/icons.svg`, © Lucide Contributors (parts © Cole Bemis, Feather, MIT). The license is in `assets/icons/lucide/LICENSE`.

## cvhelper.exe (ClipVault's own code)

- Built from `helper/cvhelper.cs` in this repo with the .NET Framework C# compiler that ships with Windows. It's part of ClipVault and MIT licensed. No third-party code is bundled in it.

## League of Legends data and images (downloaded at runtime, not shipped)

- **Champion icons** come from Riot Games' **Data Dragon** (`ddragon.leagueoflegends.com`), and **item, rune and summoner-spell icons** from **CommunityDragon** (`raw.communitydragon.org`). They're downloaded on first use and cached on your PC.
- These images and the League of Legends data are © Riot Games, Inc. They're used under Riot's "Legal Jibber Jabber" policy for fan and community projects (https://www.riotgames.com/en/legal).
- ClipVault isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

## Check before publishing

- [ ] If a packager (electron-builder) is added, check its output for any other bundled `node_modules` and add their licenses. Today `package.json` has only `electron` as a dev dependency and no runtime dependencies.
- [ ] Put the GPLv3 text and the FFmpeg source (or a written offer) in or next to the release.
- [ ] Check that `assets/icons/lucide/LICENSE` is present in the public repo.
