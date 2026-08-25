# Candy Call – native iOS shell (WKWebView)

Loads `https://candy-hosting.com/candy-call/` as a real iPhone app.

## Install (AltStore / SideStore)

1. Add AltStore source: `https://candy-hosting.com/candy-call/altstore.json`
2. Or install the IPA from Releases / `https://candy-hosting.com/candy-call/CandyCall.ipa`

Bundle ID: `com.candyhosting.call`  
Master password in-app: `648511`

## Build

GitHub Actions (macOS) builds an **unsigned** IPA on every push to `main`.
AltStore resigns it with your Apple ID when installing.
