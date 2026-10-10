# Accounts

On the Accounts tab the player signs in with Google so Lilith can answer from their Gmail, Drive
and Calendar when they ask. Each connected account gets a card: its status, what she may read
(Mail, Files, Calendar), "Online AI may read this", Try it (a real lookup that shows what she would
see) and Disconnect. Every run of `session.sh up` starts the fake Google in
`companion/scripts/mock-google.ts` and points the companion at it, so the whole sign-in works
offline. Its fixtures belong to `alex@gmail.com`: Laura's mail "Fotos del viaje", the landlord's
"Re: arriendo de octubre", a Sheet "Presupuesto octubre", a "Dentista" event tomorrow.

## Sub-features

- `accounts-connect` "Sign in with Google" goes to the consent page; Allow comes back to the tab with a card and a "Connected" note.
- `accounts-try` Try it lists what Lilith would find in each of Mail, Files and Calendar, and what she'd read in full.
- `accounts-chat` a chat message that asks for mail gets a reply built from it.
- `accounts-online` with an online AI, an account is read only once "Online AI may read this" is on; until then the tab says so.
- `accounts-facets` Mail, Files and Calendar switch off and on again within what Google granted; one it didn't grant is greyed out until "Sign in again".
- `accounts-disconnect` Disconnect asks, then removes the card and both files.

## How to get to it (user POV)

- Dashboard → Accounts tab.
- Google sends the tab back to `/#accounts?result=…`, which opens the Accounts tab directly.
- In the game, she answers from the account in her bubble, after a "Looking in your email…" status.

## Driving it with session.sh, tmux and cdp.ts

Preconditions: game-mode run, doctor passes (it checks mock Google too), dashboard open, `scripts/cdp.ts click "Accounts"`.

- **Empty tab.** `scripts/cdp.ts wait "Sign in with Google"`. Screenshot to `$EVIDENCE/accounts-empty.png`.
- **Connect.** `scripts/cdp.ts click "Sign in with Google"`, `scripts/cdp.ts wait "Allow"` (the mock consent page, on `$GOOGLE_PORT`), `scripts/cdp.ts click "Allow"`, `scripts/cdp.ts wait "Connected. Lilith can look"`. The card shows `alex@gmail.com`, "Working" and the three switches on. `ls $LILITH_AI_DATA_DIR/accounts` lists `google-<hash>.json` and `.secret`. "Deny" instead comes back with "You cancelled on Google's page".
- **Try it.** `scripts/cdp.ts type "Try it: what would she find?" "Laura"`, `scripts/cdp.ts click "Try it"`, `scripts/cdp.ts wait "Fotos del viaje"`. Mail lists it from Laura Pérez; Files and Calendar say "Nothing found."; `scripts/cdp.ts click 'What she'"'"'d read of “Fotos del viaje”'` opens the full text.
- **Chat.** The mock AI turns `!mail <q>`, `!files <q>` and `!cal <q>` into that lookup tool call when the tool is offered, and quotes the first finding's title. `tmux send-keys -t "$TMUX_SESSION" "!mail laura" Enter`: the pane shows `[thinking] Looking in your email…`, then `💬` "I looked it up: Fotos del viaje". The companion log gains `[brain] mail lookup: 1 finding(s)`.
- **Online gate.** Make the AI online but still the mock: AI tab, `click "Online service"`, `type "API key" "sk-mock"`, `click "Server address"`, `type "Address" "http://0.0.0.0:$MOCK_PORT/v1"`, `type "Model" "mock"`, `click "Save and use"`. Back on Accounts, `scripts/cdp.ts wait "Your AI is an online service"`. `!mail laura` now gets a canned reply and no new `[brain] mail lookup` line: the mock calls the email tool whenever it's offered, so a canned reply means the gate held it back. `scripts/cdp.ts click "Online AI may read this"`, `scripts/cdp.ts gone "Your AI is an online service"`, and `!mail laura` answers from the mail again.
- **Facets.** `scripts/cdp.ts click "Files"` turns it off: `facets` in the account's `.json` drops `files`, and Try it with "presupuesto" says "Lilith would find nothing". `click "Files"` again turns it on, and the same Try it lists "Presupuesto octubre" under Files.
- **A facet Google didn't grant.** The mock grants every scope, so stand in for an unticked box on Google's page by rewriting the account's `.json` with `calendar` gone from `granted` and `facets` (write a temp file in the folder, then rename it over). The watcher refreshes the tab: Calendar is greyed out with "Not allowed on Google's page. Sign in again to allow it." and "Sign in again" appears. Clicking it and Allow brings Calendar back as a switch, off, and keeps the other switches and "Online AI may read this".
- **Disconnect.** `scripts/cdp.ts click "Disconnect"` (the confirm is accepted), `scripts/cdp.ts gone "alex@gmail.com"`. `ls $LILITH_AI_DATA_DIR/accounts` prints nothing.
- **Spanish.** `scripts/cdp.ts click "Español"`: the tab reads "Cuentas", the switch "La IA en línea puede leer esta cuenta".
- **Side effects.** Copy the account's `.json` (never the `.secret`) and `grep -E "accounts|lookup" $LILITH_AI_DATA_DIR/logs/lilith-ai.log` to `$EVIDENCE` before `down`. The log names counts and durations, never the query or a token: `grep -c "laura\|ya29" ...` prints 0.

## Gotchas

- `0.0.0.0` reaches the mock on Linux but is not a local address to the companion's `isLocalUrl`, which is what makes the AI count as online. A real online service needs a real key and network: report it as not verified.
- The consent page is the mock's, not Google's: the unverified-app warning and granular consent (unticking a scope) can't be seen here. `mock-google.ts`'s `grantOnly` covers granular consent in tests.
- The "Signed out" state needs Google to reject the refresh token (`revokeRefreshTokens` in the mock, from a test); it isn't reachable from the dashboard. To see the card in it, set `"status": "reconnect"` in the `.json` the same way. A 403 or a timeout never sets it: Try it names the problem and the account stays "Working".
- A `.json` from a newer version (`"version": 2`) lists as "Needs a newer Lilith AI", with no switches and no Disconnect, since this version can't revoke its sign-in. Remove it by hand.
- `toolsSupported` is unknown until a computer-control turn or the Lilith tab's computer check has asked the model, so the "can't use tools" notice only shows after one. A chat turn whose lookup tools the model rejects doesn't record it.
