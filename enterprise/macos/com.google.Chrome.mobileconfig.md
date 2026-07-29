# macOS deployment (Chrome, Edge, Firefox, Safari)

MDM-delivered configuration profiles. Jamf, Intune, Kandji, and Mosyle all
accept the same payloads; the plist below is the payload content, not the whole
signed `.mobileconfig`.

## Chrome / Edge

Preference domain: `com.google.Chrome` (Chrome) or `com.microsoft.Edge` (Edge).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExtensionInstallForcelist</key>
  <array>
    <string>EXTENSION_ID_HERE;https://dlp.internal.fortbendcountytx.gov/ext/update.xml</string>
  </array>

  <key>ExtensionSettings</key>
  <dict>
    <key>EXTENSION_ID_HERE</key>
    <dict>
      <key>installation_mode</key><string>force_installed</string>
      <key>update_url</key>
      <string>https://dlp.internal.fortbendcountytx.gov/ext/update.xml</string>
      <key>toolbar_pin</key><string>force_pinned</string>
    </dict>
  </dict>
</dict>
</plist>
```

Managed policy for the extension itself goes in a **separate** payload keyed by
extension ID — this is the part everyone gets wrong on macOS, because unlike
Windows there is no `3rdparty` subkey. Chrome reads it from a JSON file:

```
/Library/Managed Preferences/com.google.Chrome.extensions.EXTENSION_ID_HERE.plist
```

Or, more practically, drop the policy JSON at:

```
/Library/Google/Chrome/policies/managed/dlp_data_guard.json
```

wrapped as:

```json
{
  "3rdparty": {
    "extensions": {
      "EXTENSION_ID_HERE": { "...contents of enterprise/samples/policy-baseline.json..." }
    }
  }
}
```

Set `workstationTag` per machine from your MDM's device-variable substitution
(`$DEVICENAME` in Jamf, `{{DeviceName}}` in Intune). A static tag across the
fleet makes every event look like it came from one machine, which is worse than
no attribution because it looks like real data.

## Firefox

```
/Applications/Firefox.app/Contents/Resources/distribution/policies.json
```

Same content as `enterprise/windows/firefox-policies.json`. The path is
different; the file is identical. Note that this location is inside the app
bundle, so it is wiped by a Firefox upgrade unless your MDM re-lays it down —
prefer the `/Library/Preferences/org.mozilla.firefox` configuration profile if
your MDM supports it.

## Safari

Safari is the hard one and deserves an honest assessment before it goes on a
project plan.

A Safari Web Extension is not a folder of files — it is a **native macOS app
bundle** that embeds the extension. That means:

1. Convert: `xcrun safari-web-extension-converter dist/safari-catalog`
2. Open the generated Xcode project, set a bundle identifier and team.
3. Build and sign with an **Apple Developer ID** (a paid account the county
   must own — not a personal one, or it walks out the door with whoever set it
   up).
4. Notarize the app.
5. Distribute the `.app` via MDM, then force-enable the extension with a
   configuration profile using the `com.apple.Safari.Extensions` payload:

```xml
<key>ManagedExtensions</key>
<dict>
  <key>YOUR.BUNDLE.ID (Team ID)</key>
  <dict>
    <key>State</key><string>AlwaysOn</string>
    <key>AllowedDomains</key>
    <array>
      <string>chatgpt.com</string>
      <string>claude.ai</string>
    </array>
  </dict>
</dict>
```

Safari also does not implement `chrome.storage.managed` the way Chrome and
Firefox do. The extension falls back to compiled-in defaults there, which means
**a Safari build must be compiled per-configuration** or must pull its policy
from the server endpoint. `policyEndpoint` exists partly for this reason.

**Recommendation:** unless Macs are a meaningful share of the fleet, cover
Safari with network-layer controls instead and put the Developer ID work on the
"later" list. The build target is emitted so the option stays open, not because
it is cheap.
