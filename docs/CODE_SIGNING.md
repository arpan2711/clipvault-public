# Code signing policy

ClipVault's Windows releases (the installer and the portable zip) are built from the source in this
repository by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)), from a
version tag, with no manual steps in between.

**Status:** I've applied to the [SignPath Foundation](https://signpath.org) for free code signing for
open-source projects. Until that's approved, releases are unsigned and Windows SmartScreen will warn
about them (*More info → Run anyway*). Once it's approved, releases will be signed and this page will
say so:

> Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What gets signed

Only files built from this repository: `ClipVault.exe`, `cvhelper.exe` (compiled from
[`helper/cvhelper.cs`](../helper/cvhelper.cs)), the installer and its uninstaller. FFmpeg is bundled
as the unmodified upstream build (gyan.dev) and is not signed by this project; see
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## Team and roles

ClipVault is made by one person, so every role is the same account. Everyone in a role uses
multi-factor authentication on GitHub and SignPath.

| Role | Who |
|---|---|
| Committers and reviewers (changes from anyone else arrive as pull requests and are reviewed) | [arpan2711](https://github.com/arpan2711) |
| Approvers (approve each signing request by hand) | [arpan2711](https://github.com/arpan2711) |

## Privacy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. In detail:

- **Your clips, recordings, match stats, settings and logs never leave your PC.** There is no
  account, no telemetry and no analytics.
- **Game icons:** champion, item, rune and spell pictures are downloaded from Riot's Data Dragon
  (`ddragon.leagueoflegends.com`) and CommunityDragon (`raw.communitydragon.org`) the first time they're
  needed, and cached. Only the file names of the icons are requested.
- **Update check:** on start and once a day, ClipVault asks GitHub's public Releases API whether a
  newer version exists. It never downloads or installs anything by itself. Turn it off in
  **Settings → About → Check for updates automatically**.
- **Bug reports** are only sent when you press *Open on GitHub*, which opens your browser with the
  report for you to read and submit. Personal details (your Windows user name, Riot IDs, email
  addresses) are removed first, and *What's included* shows the exact text.
- **League of Legends:** ClipVault reads Riot's local game and client APIs on your own PC
  (`127.0.0.1`). Nothing is sent to Riot or anyone else.

## Uninstalling

The installer adds ClipVault to *Settings → Apps*, from where it can be removed. Removing it also
takes out its start-with-Windows entry. Your clips in `Videos\ClipVault` are kept.
