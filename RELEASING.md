# Releasing TradingView Alerts

## One-time setup

### 1. Updater signing key (already generated)

The keypair is already generated and the public key is in `tauri.conf.json`.

Add the private key as a GitHub secret:

```
Secret name:  TAURI_SIGNING_PRIVATE_KEY
Secret value: (contents of /tmp/tvalert-update.key — keep this safe, back it up)
Secret name:  TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Secret value: (empty string — key has no password, but the secret must exist)
```

> **Back up the private key.** If you lose it, existing users can never receive
> auto-updates. Store it in 1Password or similar.

### 2. Apple code signing + notarization (for gatekeeper-free installs)

Without this, users see "Apple could not verify this app is free from malware"
and need to right-click → Open. It's a friction point — set this up before
your first public release.

**Requirements:**
- Apple Developer account ($99/yr) → https://developer.apple.com
- A "Developer ID Application" certificate (NOT "Apple Distribution")

**Export the certificate:**
1. Xcode → Settings → Accounts → Manage Certificates
2. Right-click "Developer ID Application: Your Name (TEAMID)" → Export
3. Save as `certificate.p12` with a password

**Add GitHub secrets:**

| Secret | Value |
|--------|-------|
| `APPLE_CERTIFICATE` | `base64 -i certificate.p12` output |
| `APPLE_CERTIFICATE_PASSWORD` | Password you set on the .p12 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `KEYCHAIN_PASSWORD` | Any random string (used for temp keychain) |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your 10-char team ID (e.g. `ABC1234567`) |

If these secrets are absent, the workflow builds unsigned (works for testing,
not for public distribution).

### 3. GitHub token

`GITHUB_TOKEN` is provided automatically by Actions — no setup needed.

---

## Releasing a new version

```bash
# 1. Bump version in two places:
#    apps/desktop/src-tauri/tauri.conf.json  → "version": "1.0.1"
#    apps/desktop/src-tauri/Cargo.toml       → version = "1.0.1"

# 2. Commit
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml
git commit -m "chore: release v1.0.1"

# 3. Tag and push — this triggers the release workflow
git tag v1.0.1
git push origin main --tags
```

The workflow will:
1. Build a universal macOS binary (arm64 + x86_64 in one `.app`)
2. Sign and notarize if Apple secrets are present
3. Create a `.dmg` for first-time installs
4. Create a `.tar.gz` + `.sig` for the updater
5. Generate `latest.json` and upload everything to a GitHub Release

Existing users get an in-app update prompt within ~24h (the updater checks on launch).

---

## Download page / install UX

Point users to:
```
https://github.com/pasevin/tradingview-alerts/releases/latest
```

Or add a direct DMG link on your landing page:
```
https://github.com/pasevin/tradingview-alerts/releases/latest/download/TradingView%20Alerts_1.0.6_universal.dmg
```

For the smoothest experience, link directly to the `.dmg`. Users:
1. Download `TradingView Alerts.dmg`
2. Open it, drag to Applications
3. Launch — no gatekeeper warning (if signed + notarized)
4. App appears in the menu bar immediately

---

## Unsigned distribution (no Apple Developer account)

If you're distributing without signing, include these instructions for users:

> After downloading, right-click the app → Open → Open (bypass Gatekeeper once).
> Or run: `xattr -cr /Applications/TradingView\ Alerts.app`

---

## Local release build (test before tagging)

```bash
cd apps/desktop
TAURI_SIGNING_PRIVATE_KEY=$(cat /tmp/tvalert-update.key) \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
pnpm exec tauri build --target universal-apple-darwin
```

Output: `src-tauri/target/universal-apple-darwin/release/bundle/`
