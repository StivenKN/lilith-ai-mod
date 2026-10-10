import { useEffect, useState } from "react";
import type { Outcome } from "../../src/accounts/flows.ts";
import { privateFacets, type PrivateFacet } from "../../src/lookup/facets.ts";
import { audienceOf } from "../../src/lookup/gate.ts";
import { call, useRpc, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Field, Note, Toggle, useLocale, useTr } from "../ui.tsx";

type Account = Output<"accounts">["accounts"][number];
type Entry = Output<"accounts">["catalog"][number];

const outcomeTones = { connected: "ok", denied: "warn", failed: "error", expired: "warn", finished: "ok" } as const satisfies Record<Outcome, "ok" | "warn" | "error">;
const isOutcome = (value: string): value is Outcome => Object.hasOwn(outcomeTones, value);

/** The outcome the sign-in callback left in `#accounts?result=…`. Any other value is ignored. */
export function outcomeIn(hash: string): Outcome | null {
  const result = new URLSearchParams(hash.split("?")[1] ?? "").get("result");
  return result !== null && isOutcome(result) ? result : null;
}

/** A facet's switch turns on and off within what Google granted; past the grant, only a new sign-in brings it. */
export const facetSwitch = (account: Pick<Account, "facets" | "granted">, facet: PrivateFacet) =>
  !account.granted.includes(facet) ? "unavailable" : account.facets.includes(facet) ? "on" : "off";

/** The facets `updateAccount` gets when one switch flips; the store keeps them within the grant. */
export const withFacet = (account: Pick<Account, "facets">, facet: PrivateFacet, on: boolean): PrivateFacet[] =>
  privateFacets.filter((kept) => (kept === facet ? on : account.facets.includes(kept)));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Same tab, not a popup (P-CALLBACK): Google sends this tab back to `/#accounts?result=…`. */
async function signIn(input: { entry: string; shareOnline: boolean }, onFailed: (message: string) => void): Promise<void> {
  const started = await call("connectAccount", input);
  if (started.kind === "consent") location.assign(started.url);
  else onFailed(started.message);
}

/** The Accounts tab: what Lilith may read, one card per connected account, and the sign-in buttons. */
export function AccountsPage(props: { overview: Overview; tick: number }) {
  const tr = useTr();
  const accounts = useRpc("accounts");
  const [outcome] = useState(() => outcomeIn(location.hash));
  const { provider } = props.overview.config;

  // Read once, so a reload doesn't announce the sign-in again.
  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname);
  }, []);
  useEffect(() => {
    void accounts.reload();
  }, [props.tick]);

  const data = accounts.data;
  const sharedOnline = data?.accounts.some((account) => account.policy.shareOnline) ?? false;

  return (
    <>
      <h1>{tr("accounts.title")}</h1>
      <p>{tr("accounts.intro")}</p>
      <p className="hint">{tr("accounts.privacy")}</p>
      {outcome && (
        <Note tone={outcomeTones[outcome]}>
          <p>{tr(`accounts.result.${outcome}`)}</p>
        </Note>
      )}
      {accounts.error && (
        <Note tone="error" detail={accounts.error}>
          <p>{tr("accounts.loadFailed")}</p>
        </Note>
      )}
      {data && (
        <>
          {data.toolsSupported === false && (
            <Note tone="warn">
              <p>{tr("accounts.noTools", { model: provider.model })}</p>
            </Note>
          )}
          {audienceOf(provider) === "online" && data.accounts.length > 0 && !sharedOnline && (
            <Note tone="warn">
              <p>{tr("accounts.onlineNotShared")}</p>
            </Note>
          )}
          {data.accounts.length > 0 && (
            <ul className="accounts">
              {data.accounts.map((account) => (
                <AccountCard key={account.id} account={account} entry={data.catalog.find((entry) => entry.id === account.entry)} reload={() => void accounts.reload()} />
              ))}
            </ul>
          )}
          <h2>{tr("accounts.addTitle")}</h2>
          {data.catalog.map((entry) => (
            <AddAccount key={entry.id} entry={entry} configured={data.googleConfigured} />
          ))}
        </>
      )}
    </>
  );
}

function AddAccount(props: { entry: Entry; configured: boolean }) {
  const tr = useTr();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const fail = (message: string) => {
    setBusy(false);
    setFailed(message);
  };

  return (
    <div className="account">
      <strong>{props.entry.name}</strong>
      <p className="hint">{props.entry.help[locale]}</p>
      {props.configured ? (
        <>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailed(null);
              void signIn({ entry: props.entry.id, shareOnline: false }, fail).catch((error: unknown) => fail(messageOf(error)));
            }}
          >
            {busy ? tr("accounts.signingIn") : tr("accounts.signIn", { name: props.entry.name })}
          </button>
          <p className="hint">{tr("accounts.unverified")}</p>
        </>
      ) : (
        <Note tone="warn">
          <p>{tr("accounts.noClient")}</p>
        </Note>
      )}
      {failed && (
        <Note tone="error">
          <p>{failed}</p>
        </Note>
      )}
    </div>
  );
}

function AccountCard(props: { account: Account; entry: Entry | undefined; reload: () => void }) {
  const tr = useTr();
  const { account, entry } = props;
  const [failed, setFailed] = useState<string | null>(null);
  const act = (work: Promise<unknown>) => {
    setFailed(null);
    void work.catch((error: unknown) => setFailed(messageOf(error))).finally(props.reload);
  };
  const offered: readonly PrivateFacet[] = entry?.facets ?? account.granted;
  const ungranted = offered.some((facet) => facetSwitch(account, facet) === "unavailable");

  return (
    <li className="account">
      <div className="account-head">
        <strong>{account.label}</strong>
        <span className="account-status" data-status={account.status}>
          {tr(`accounts.status.${account.status}`)}
        </span>
      </div>
      {account.status === "reconnect" && <p className="hint">{tr("accounts.reconnectHint")}</p>}
      {/* This version can neither read a newer account nor revoke its sign-in, so it only names it. */}
      {account.status === "needs-newer-version" ? (
        <p className="hint">{tr("accounts.newerHint")}</p>
      ) : (
        <>
          <div className="account-facets" role="group" aria-label={tr("accounts.facetsLabel")}>
            {offered.map((facet) => {
              const state = facetSwitch(account, facet);
              return (
                <Toggle
                  key={facet}
                  checked={state === "on"}
                  disabled={state === "unavailable"}
                  label={tr(`accounts.facet.${facet}`)}
                  hint={state === "unavailable" ? tr("accounts.facetUnavailable") : undefined}
                  onChange={(on) => act(call("updateAccount", { id: account.id, facets: withFacet(account, facet, on) }))}
                />
              );
            })}
          </div>
          <Toggle
            checked={account.policy.shareOnline}
            label={tr("accounts.shareOnline")}
            hint={tr("accounts.shareOnlineHint")}
            onChange={(shareOnline) => act(call("updateAccount", { id: account.id, policy: { shareOnline } }))}
          />
          {account.status === "ok" && <TryIt id={account.id} />}
          <div className="row">
            {entry && (account.status === "reconnect" || ungranted) && (
              <button className="secondary" onClick={() => act(signIn({ entry: entry.id, shareOnline: account.policy.shareOnline }, setFailed))}>
                {tr("accounts.signInAgain")}
              </button>
            )}
            <button
              className="secondary danger"
              onClick={() => {
                if (confirm(tr("accounts.disconnectConfirm", { label: account.label }))) act(call("disconnectAccount", { id: account.id }));
              }}
            >
              {tr("accounts.disconnect")}
            </button>
          </div>
        </>
      )}
      {failed && (
        <Note tone="error">
          <p>{failed}</p>
        </Note>
      )}
    </li>
  );
}

/** A real lookup in every facet the account has on, so the player sees what Lilith would see. */
function TryIt(props: { id: Account["id"] }) {
  const tr = useTr();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Output<"tryAccount"> | null>(null);
  const field = `try-${props.id}`;

  const run = async () => {
    setBusy(true);
    setResult(null);
    setResult(await call("tryAccount", { id: props.id, query }).catch((error: unknown) => ({ ok: false as const, message: messageOf(error) })));
    setBusy(false);
  };

  return (
    <>
      <Field id={field} label={tr("accounts.tryLabel")}>
        <div className="row">
          <input
            id={field}
            className="grow"
            value={query}
            placeholder={tr("accounts.tryPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.trim() && !busy) void run();
            }}
          />
          <button className="secondary" disabled={busy || !query.trim()} onClick={() => void run()}>
            {tr(busy ? "accounts.trying" : "accounts.try")}
          </button>
        </div>
      </Field>
      {result && <TryResult result={result} />}
    </>
  );
}

function TryResult(props: { result: Output<"tryAccount"> }) {
  const tr = useTr();
  const { result } = props;
  if (!result.ok)
    return (
      <Note tone="error">
        <p>{result.message}</p>
      </Note>
    );
  const found = result.sections.some((section) => section.findings.length > 0);
  return (
    <Note tone={found ? "ok" : "warn"}>
      <p>{tr(found ? "accounts.tryFound" : "accounts.tryNothing", { query: result.query })}</p>
      {result.sections.map((section) => (
        <div key={section.facet} className="account-found">
          <strong>{tr(`accounts.facet.${section.facet}`)}</strong>
          {section.findings.length > 0 ? (
            <ul>
              {section.findings.map((finding, index) => (
                <li key={index}>
                  {finding.title} <span className="hint">{finding.meta}</span>
                  {finding.excerpt ? <span className="hint" style={{ display: "block" }}>{finding.excerpt}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <span className="hint"> {tr("accounts.tryEmpty")}</span>
          )}
          {section.expanded && (
            <details>
              <summary>{tr("accounts.tryExpanded", { title: section.expanded.title })}</summary>
              <p>{section.expanded.text}</p>
            </details>
          )}
          {section.problems.map((problem) => (
            <p key={problem.label} className="hint">
              {tr(`accounts.problem.${problem.problem}`)}
            </p>
          ))}
        </div>
      ))}
    </Note>
  );
}
