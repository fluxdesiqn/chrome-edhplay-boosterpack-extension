# Installing without any developer tools

You do not need Node, npm or Git. You need Chrome (or Edge/Brave) and about two minutes.

## 1. Download the extension

Go to the project's **Releases** page on GitHub and download the newest file named
`heroes-of-kamigawa-edhplay-vX.Y.Z.zip`.

## 2. Unzip it somewhere permanent

Right-click the zip → **Extract All**. Put the folder somewhere you will not delete,
for example `Documents\HeroesOfKamigawa`. Chrome loads the extension from this folder
every time it starts, so if the folder disappears the extension stops working.

## 3. Load it in Chrome

1. Open a new tab and go to `chrome://extensions`
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked**.
4. Select the folder you extracted (the one that contains `manifest.json`).

The card "Heroes of Kamigawa for EDHPlay" appears. Chrome will show a small
"Disable developer mode extensions" reminder at startup; that is normal for
extensions installed this way, just close it.

## 4. Use it

Open your edhplay.com game. **If the game page was already open, reload it once**:
the extension can only attach before the game connects. The panel appears
bottom-right; `Alt+K` hides and shows it.

Everyone in your pod who wants to see the real cards installs it the same way.
Players without it see basic lands and a few `[HoK1]` chat lines instead.

## Updating

Download the new zip, extract it **over the same folder** (replace files), then
go to `chrome://extensions`, click the circular **Reload** arrow on the card, and
reload your edhplay tab.

## Uninstalling

`chrome://extensions` → **Remove** on the card. You can then delete the folder.
