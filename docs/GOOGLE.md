# Google sign-in: one-time setup

The mod owns one Google OAuth client. Players click "Sign in with Google" in the dashboard's
Accounts tab, and Lilith can then read their Gmail, Drive and Calendar when they ask. This page is
for whoever maintains the release: how to create that client and where its two values go. Neither
value lives in the repository.

## Create the client

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (for example
   "Lilith AI Companion").
2. Under **APIs & Services → Library**, enable the **Gmail API**, the **Google Drive API** and the
   **Google Calendar API**.
3. Under **APIs & Services → OAuth consent screen**, choose **External**, fill in the app name,
   support email and developer contact, and add these scopes:
   - `openid`, `.../auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.readonly` (restricted)
   - `https://www.googleapis.com/auth/drive.readonly` (restricted)
   - `https://www.googleapis.com/auth/calendar.readonly` (sensitive)
4. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type **Desktop app**.
   The redirect is `http://127.0.0.1:<port>/api/accounts/callback`; Desktop clients accept any
   loopback port, which the dashboard needs because its port changes from run to run.
5. Copy the client ID and the client secret.

## Put the values in the release

Add two repository secrets on GitHub (**Settings → Secrets and variables → Actions**):

- `LILITH_GOOGLE_CLIENT_ID`
- `LILITH_GOOGLE_CLIENT_SECRET`

`release.yml` passes them to `bun build.ts`, which bakes them into `LilithAICompanion.exe` with
`bun build --define`. A build without them (CI, a local `bun build.ts`) hides the Google tile and
tells the player why, and the release job prints a workflow warning. A build with them also
defines `LILITH_AI_GOOGLE_URL` away, so a release cannot be pointed at another host. The secret is
a "Desktop app" secret: Google documents that it cannot be kept confidential in an installed app,
and the flow also uses PKCE.

## While the app is unverified

- The consent screen stays in **Testing** until Google verifies the restricted scopes. In Testing,
  only the **test users** you list can sign in (up to 100), Google shows the "unverified app"
  warning, and refresh tokens expire after 7 days. The account then shows "connect again" in the
  dashboard. Connecting again keeps the player's choices (the facets they narrowed to, the online
  opt-in), and every sign-in asks for every scope afresh, so a scope they untick stays unticked.
- Publishing the app without verification keeps the warning and caps the client at 100 users for
  its lifetime.
- Verification for `gmail.readonly` and `drive.readonly` needs a privacy policy URL, a demo video
  of the flow, and a security assessment. Start it once the feature is settled.

## Testing without Google

`companion/scripts/mock-google.ts` serves the consent page, the token endpoints and fixtures for
the three APIs, including a Latin-1 mail, an HTML-only mail and a message too big to read. Point
the companion at it with `LILITH_AI_GOOGLE_URL` (a development build only; a release ignores it),
and set any value in the two client variables. `companion/src/accounts/` tests run against it, and
can expire tokens, revoke them, grant fewer scopes or answer every call with a 401 or 403.
