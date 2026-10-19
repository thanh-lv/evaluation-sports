# Apple setup: subscriptions, Sign in with Apple, DeviceCheck

Everything the server side of M8–M9 needs from Apple, in the order to do it. Products, prices, the subscription group
and store copy are in [`docs/appstore/subscriptions.md`](appstore/subscriptions.md); this page covers keys, secrets,
the notification URL and how to check that it all works. Design references: DESIGN.md §9.1, §9.4, §9.5, §6.1, §11.

You need: the Apple Developer account (Admin), App Store Connect access, the Supabase project ref, and the Supabase CLI
(`npx -y supabase@2.119.0`).

## 1. Identifiers you will copy

| Value | Where to find it | Secret name |
|---|---|---|
| Bundle ID (`com.<company>.racketcoach`) | Certificates, Identifiers & Profiles › Identifiers | `APPLE_BUNDLE_ID` |
| Team ID (10 characters) | developer.apple.com › Membership details | `APPLE_TEAM_ID` |
| App Apple ID (numeric) | App Store Connect › your app › App Information › General | `APPLE_APP_APPLE_ID` |

The bundle ID must equal the `bundleId` inside every StoreKit transaction; `verify-subscription` rejects anything else
with 422.

## 2. Enable the capabilities on the App ID

Certificates, Identifiers & Profiles › Identifiers › the app's App ID › enable:
- **Sign in with Apple** (as a primary App ID);
- **In-App Purchase** (on by default);
- **DeviceCheck** needs no capability, only a key (step 4).

## 3. App Store Server API key (In-App Purchase key)

1. App Store Connect › **Users and Access › Integrations › In-App Purchase** › Generate (or "+").
2. Download `SubscriptionKey_<KEYID>.p8` (it can be downloaded **once**; store it in the team password manager).
3. Copy the **Key ID** and the **Issuer ID** shown at the top of the page.

| Secret | Value |
|---|---|
| `APPLE_IAP_KEY_ID` | Key ID |
| `APPLE_IAP_ISSUER_ID` | Issuer ID (a UUID) |
| `APPLE_IAP_PRIVATE_KEY` | Full contents of the `.p8`, including the `-----BEGIN PRIVATE KEY-----` lines |

The server signs a 20-minute ES256 token (`aud: appstoreconnect-v1`, `bid: APPLE_BUNDLE_ID`) for
`GET /inApps/v1/subscriptions/{id}`, `GET /inApps/v1/transactions/{id}`, Set App Account Token
(`PUT /inApps/v1/transactions/{originalTransactionId}/appAccountToken`), Send Consumption Information
(`PUT /inApps/v2/transactions/consumption/{id}`) and Get Notification History. The same key works for Production and
Sandbox.

## 4. Sign in with Apple key and DeviceCheck key

Certificates, Identifiers & Profiles › **Keys** › "+":
1. Name it `RacketCoach server`, tick **Sign in with Apple** (Configure → primary App ID = the app) and **DeviceCheck**.
   One key may carry both services; separate keys also work.
2. Download `AuthKey_<KEYID>.p8` (once only) and note the Key ID.

| Secret | Value |
|---|---|
| `APPLE_SIWA_KEY_ID` | Key ID of the key with Sign in with Apple |
| `APPLE_SIWA_PRIVATE_KEY` | Its `.p8` contents |
| `APPLE_SIWA_CLIENT_ID` | Leave empty: defaults to the bundle ID (native sign-in). Set it only for a Services ID (web) |
| `APPLE_DEVICECHECK_KEY_ID` | Key ID of the key with DeviceCheck |
| `APPLE_DEVICECHECK_PRIVATE_KEY` | Its `.p8` contents |
| `APPLE_DEVICECHECK_HOST` | `api.devicecheck.apple.com` (production builds). Development builds signed with a development profile must use `api.development.devicecheck.apple.com` |

What they are used for:
- `apple-auth-exchange` exchanges the one-time `authorizationCode` (valid 5 minutes) from
  `ASAuthorizationAppleIDCredential` at `https://appleid.apple.com/auth/token` and stores the refresh token
  AES-GCM-encrypted (`TOKEN_ENC_KEY`), bound to the user id.
- `delete-account` revokes that token at `/auth/revoke` (App Review guideline 5.1.1(v)). Without a stored token the
  response carries `siwaManualRevoke: true` for Apple sign-in accounts and the app explains how to remove the app in
  Settings › Apple ID › Sign in with Apple.
- DeviceCheck's two bits guard the free first-ever Sonnet analysis per device (`/analyze/submit`).

## 5. Supabase Auth: Apple provider (native)

Supabase dashboard › Authentication › Sign In / Providers › **Apple**: enable it and put the **bundle ID** in
"Client IDs". Native sign-in (`signInWithIdToken` / `linkIdentityWithIdToken`) needs no secret key in Supabase. Also
enable **Anonymous sign-ins** (D14) and **Email** (OTP). After an anonymous user signs in to an identity that already
has an account, the app calls `/account-merge` with the old anonymous access token (it must be at most 1 hour old).

## 6. Secrets for the project

Generate the local secrets once (keep them; rotating `TOKEN_ENC_KEY` makes stored SIWA tokens unreadable, and rotating
`AUDIT_PEPPER` breaks the link between old and new audit rows of the same deleted user):

```bash
openssl rand -base64 32   # TOKEN_ENC_KEY
openssl rand -hex 32      # AUDIT_PEPPER
```

Set everything on the hosted project (multi-line PEMs are fine with `$(cat …)`; a one-line value with literal `\n` also
works):

```bash
SB="npx -y supabase@2.119.0"
$SB secrets set --project-ref <ref> \
  APPLE_BUNDLE_ID=com.<company>.racketcoach APPLE_APP_APPLE_ID=<numeric id> APPLE_TEAM_ID=<team id> \
  APPLE_IAP_KEY_ID=<id> APPLE_IAP_ISSUER_ID=<uuid> APPLE_IAP_PRIVATE_KEY="$(cat SubscriptionKey_<id>.p8)" \
  APPLE_SIWA_KEY_ID=<id> APPLE_SIWA_PRIVATE_KEY="$(cat AuthKey_<id>.p8)" \
  APPLE_DEVICECHECK_KEY_ID=<id> APPLE_DEVICECHECK_PRIVATE_KEY="$(cat AuthKey_<id>.p8)" \
  TOKEN_ENC_KEY=<base64 32 bytes> AUDIT_PEPPER=<hex>
```

Do **not** set `ALLOW_XCODE_ENV` on the production project (it defaults to false). Locally, copy
`supabase/functions/.env.example` to `supabase/functions/.env` and fill the same names.

Optional settings:

| Secret | Default | When to set it |
|---|---|---|
| `APPLE_API_HOST_PROD` / `APPLE_API_HOST_SANDBOX` | `api.storekit.apple.com` / `api.storekit-sandbox.apple.com` | Only to point at a mock server in tests |
| `APPLE_ROOT_CA_G3_PEM` | empty | Apple Root CA - G3 is **embedded** in `_shared/apple/jws.ts` (SHA-256 `63:34:3A:BF:…:3E:91:79`). This variable *adds* roots, e.g. if Apple ever introduces a new root. Get the certificate from <https://www.apple.com/certificateauthority/>, convert with `openssl x509 -inform der -in AppleRootCA-G3.cer -out root.pem`, and compare `openssl x509 -in root.pem -noout -fingerprint -sha256` with Apple's published value before setting it |
| `ALLOW_XCODE_ENV` | `false` | `true` **only** on the dev project used for Xcode StoreKit testing (M14/M15) |

## 7. Deploy the functions

```bash
$SB functions deploy verify-subscription appstore-webhook apple-auth-exchange account-merge delete-account \
  --project-ref <ref>
```

`supabase/config.toml` sets `verify_jwt = false` for all of them: each function checks the user JWT itself, and Apple
calls the webhook without one.

## 8. App Store Server Notifications V2

App Store Connect › your app › **App Information › App Store Server Notifications**:
- Production Server URL: `https://<ref>.supabase.co/functions/v1/appstore-webhook`
- Sandbox Server URL: the same URL
- Version: **Version 2**

The webhook verifies the `signedPayload` chain (Apple Root CA G3, OIDs `1.2.840.113635.100.6.2.1` and
`…6.11.1`), stores each notification in `private.appstore_notifications` (duplicates are answered 200 without work once
processed), re-fetches the subscription from Apple and acts only on that (a REFUND or REVOKE needs status 5 or a
`revocationDate` in the re-fetched transaction). It answers 500 only on transient failures, so Apple retries. The daily
cron additionally replays the last 26 hours of notification history for Production and Sandbox
(`syncNotificationHistory` in `_shared/apple/notifications.ts`).

**Refund consumption data.** For a `CONSUMPTION_REQUEST` the server calls Send Consumption Information only when the
user opted in (`profiles.consumption_consent`), reporting the share of the period's analyses used. Otherwise it only
logs the request.

## 9. Check that it works

1. **Sandbox tester:** App Store Connect › Users and Access › Sandbox › Testers › "+". On the iPhone, sign in under
   Settings › Developer › Sandbox Apple Account.
2. Buy the monthly plan from a TestFlight or development build. Expect `POST /verify-subscription` → 200 with
   `tier: "premium"` and, within a minute, a `SUBSCRIBED` row:

   ```sql
   select notification_type, subtype, status, error, received_at
   from private.appstore_notifications order by received_at desc limit 5;
   select original_transaction_id, user_id, status, expires_at, environment from public.app_store_subscriptions;
   ```
3. **Restore on a second account:** sign out (new anonymous user), tap Restore. Expect `transferred: true` and an
   `audit_log` row `subscription_transfer`. A purchase sync from a different account without Restore answers 409
   `linked_to_other_account`. More than 3 transfers of one subscription within 30 days answer 429
   `transfer_rate_limited`.
4. **Refund** a sandbox purchase (Settings › Developer › Sandbox Apple Account › Manage, or a StoreKit test refund).
   Expect a `REFUND` notification, `status = 5`, `revoked_at` set and the user back to free.
5. **Delete the account** in Settings: the response has `deleted: true`; the auth user, both Storage folders and the
   stored SIWA token are gone, the subscription row keeps billing data with `user_id = null`, and
   `private.audit_log` has `account_deleted` with a hashed subject.

## 10. Troubleshooting

| Symptom (function log or response) | Likely cause |
|---|---|
| 500 and log `apple api 401` | Wrong `APPLE_IAP_KEY_ID` / `APPLE_IAP_ISSUER_ID` / key contents, or `APPLE_BUNDLE_ID` differs from the app |
| 422 `unknown transaction` (Apple 4040010) | Transaction from the other environment (TestFlight and development builds are Sandbox) or from another app |
| 403 `transaction signature not trusted` | The client's JWS chain failed verification (forged, or an Xcode transaction on a project without `ALLOW_XCODE_ENV`) |
| 403 `Xcode environment not accepted` | An Xcode StoreKit test transaction reached a project with `ALLOW_XCODE_ENV=false` (expected in production) |
| Webhook answers 401 | `signedPayload` chain rejected; check that the URL is not being called by something other than Apple |
| `missing environment: APPLE_…` in the logs | A secret from steps 3–6 is not set on this project |
| `siwaManualRevoke: true` for an Apple user | No stored refresh token: the app never called `/apple-auth-exchange`, the code had expired, or `TOKEN_ENC_KEY` was rotated |
| DeviceCheck 400 in development builds | `APPLE_DEVICECHECK_HOST` must be `api.development.devicecheck.apple.com` for development-signed builds |
