#!/bin/bash
# Builds the Safari version of Plex → IINA and installs it in ~/Applications.
# languages.js, content.js, download.js, popup.html, popup.js and icons/ are shared with the
# Chrome extension in ../plex-to-iina, so run this again after changing them.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
shared="$here/../plex-to-iina"
ext="$here/extension"
app_name="Plex to IINA"
installed="$HOME/Applications/$app_name.app"
# Xcode's build files (~170 MB) live outside the project folder.
build_dir="${TMPDIR:-/tmp}/plex-to-iina-safari-build"

# 1. Assemble the web extension: shared scripts plus Safari's manifest and background.
mkdir -p "$ext"
cp "$shared/languages.js" "$shared/content.js" "$shared/download.js" "$shared/popup.html" "$shared/popup.js" "$ext/"
rm -rf "$ext/icons" && cp -R "$shared/icons" "$ext/icons"
cp "$here/manifest.json" "$here/background.js" "$ext/"

# 2. Build the Mac app that carries the extension. With an Apple Development certificate
#    in your keychain (any free Apple ID added in Xcode gives you one) it's signed with
#    that team; set DEVELOPMENT_TEAM to pick a team yourself. Without one it's signed to
#    run locally only, and Safari needs Settings → Developer → Allow unsigned extensions.
team="${DEVELOPMENT_TEAM:-$(security find-certificate -c "Apple Development" -p 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null | sed -nE 's/.*OU ?= ?([A-Z0-9]{10}).*/\1/p' | head -1)}"
if [ -n "$team" ]; then
  echo "Signing with Apple Development team $team"
  signing=(DEVELOPMENT_TEAM="$team" -allowProvisioningUpdates)
else
  echo "No Apple Development certificate found: signing to run locally"
  signing=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=)
fi
xcodebuild \
  -project "$here/$app_name/$app_name.xcodeproj" \
  -scheme "$app_name" \
  -configuration Release \
  -derivedDataPath "$build_dir" \
  -quiet \
  "${signing[@]}" \
  build

# 3. Install it and launch it once, which registers the extension with Safari.
#    xcodebuild also registered the copy in the build folder; forget that one, or Safari
#    may load the extension (and macOS open the app) from there instead.
built="$build_dir/Build/Products/Release/$app_name.app"
mkdir -p "$HOME/Applications"
rm -rf "$installed"
ditto "$built" "$installed"
pluginkit -r "$built/Contents/PlugIns/$app_name Extension.appex" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -u "$built" 2>/dev/null || true
open "$installed"

echo "Installed $installed"
echo "Turn it on in Safari → Settings → Extensions → Plex → IINA."
echo "If Safari was open, quit it (⌘Q) and reopen it: replacing the app while Safari runs"
echo "can stop Safari from starting the part that opens IINA until it restarts."
