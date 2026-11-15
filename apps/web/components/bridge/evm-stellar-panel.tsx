"use client";

import { StrKey } from "@stellar/stellar-sdk";
import { type Quote, createXebraClient } from "@xebra/sdk";
import type { EvmChain } from "@xebra/sdk/core";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { ensureChain, sendTransaction, waitForReceipt } from "../../lib/evm-rpc";
import { reportError } from "../../lib/format-error";
import { claimOnStellar } from "../../lib/sui-stellar/claim-client";
import { Button } from "../ui/button";
import { DataRow } from "../ui/data-row";
import { Field, Input } from "../ui/field";
import { InsetTray } from "../ui/glass-card";
import { ArrowRight } from "../ui/icons";
import { Notice } from "../ui/notice";
import { StripeRule } from "../ui/stripe-rule";
import { useWallets } from "../wallet/wallet-provider";

/**
 * An EVM chain to Stellar. Circle does not deliver into Stellar: the burn names Circle's Stellar
 * forwarder, and Xebra's relayer completes the mint once Circle has attested it.
 *
 * Priced and built by Xebra's own API (`/v1/quote`, `/v1/transfers`), which checks the recipient's
 * account and USDC trustline before anything is signed. The wallet signs each step in order: an
 * approval when needed, the burn, then Xebra's fee. Afterwards the page asks the relayer to finish
 * (`/api/stellar-inbound/complete`) until it has.
 */

const DECLINED = /reject|denied|cancel/i;
const STANDARD_ETA =
  "Circle attests it once the chain has finalised the burn, usually 15 to 20 minutes, then Xebra completes the mint on Stellar.";

type Delivery =
  | { kind: "waiting" }
  | { kind: "completing" }
  | { kind: "done"; hash: string | null }
  | { kind: "stuck"; message: string };

export function EvmStellarPanel({
  source,
  onBusyChange,
}: {
  source: EvmChain;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { connections, stellarKit, open: openWallets } = useWallets();
  const stellarAddress = connections.stellar?.address ?? null;
  const [claiming, setClaiming] = useState(false);
  const wallet = connections.evm ?? null;
  const client = useMemo(
    () =>
      createXebraClient({
        baseUrl: typeof window === "undefined" ? "" : window.location.origin,
        // The route list behind a quote is read from the Stellar contract and cached; a cold read
        // can take longer than the client's usual 15 seconds.
        timeoutMs: 60_000,
      }),
    [],
  );

  const [amount, setAmount] = useState("5");
  const [recipient, setRecipient] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; declined: boolean } | null>(null);
  const [sent, setSent] = useState<{ tx: Hex; feePaid: boolean } | null>(null);
  const [delivery, setDelivery] = useState<Delivery>({ kind: "waiting" });

  const recipientOk = StrKey.isValidEd25519PublicKey(recipient.trim());
  const amountOk = /^\d{1,12}(\.\d{1,6})?$/.test(amount.trim()) && Number(amount) > 0;
  const busy = step !== null || sent !== null;

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  // Priced as the API prices it, a moment after typing stops.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!amountOk) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .quote({ from: source.id, to: "stellar", amount: amount.trim() })
        .then((q) => {
          if (!cancelled) setQuote(q);
        })
        .catch((err: unknown) => {
          if (!cancelled) setQuoteError(err instanceof Error ? err.message : String(err));
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, source.id, amount, amountOk]);

  // After the burn: ask the relayer to finish, every 20 seconds, until it has or says it cannot.
  const asking = useRef(false);
  useEffect(() => {
    if (!sent) return;
    let cancelled = false;
    const tick = async () => {
      if (asking.current) return;
      asking.current = true;
      try {
        const res = await fetch("/api/stellar-inbound/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ src: source.cctpDomainId, tx: sent.tx }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          status?: string;
          hash?: string;
          reason?: string;
        };
        if (cancelled) return;
        if (body.status === "delivered" || (body.status === "submitted" && body.hash)) {
          setDelivery({ kind: "done", hash: body.hash ?? null });
        } else if (body.status === "refused" || body.status === "failed") {
          setDelivery({
            kind: "stuck",
            message: body.reason ?? "The mint could not be completed.",
          });
        } else if (body.status === "submitted") {
          setDelivery({ kind: "completing" });
        }
      } catch {
        // A dropped request is not a failed transfer; the next tick asks again.
      } finally {
        asking.current = false;
      }
    };
    void tick();
    const timer = setInterval(tick, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sent, source.cctpDomainId]);

  async function send() {
    if (!wallet?.provider || !wallet.address) {
      openWallets(["evm"]);
      return;
    }
    const provider = wallet.provider;
    const from = wallet.address;
    setError(null);
    try {
      setStep(`Switch your wallet to ${source.name}`);
      await ensureChain(provider, source);
      setStep("Preparing the transfer");
      const build = await client.createTransfer({
        from: source.id,
        to: "stellar",
        amount: amount.trim(),
        sender: from,
        recipient: recipient.trim(),
        ...(quote ? { maxTotalFee: quote.fees.total } : {}),
      });
      let burn: Hex | null = null;
      let feePaid = false;
      for (const s of build.steps) {
        if (s.tx.kind !== "evm") throw new Error("Unexpected transaction for an EVM wallet.");
        const tx = { from, to: s.tx.to, data: s.tx.data as Hex, chainId: s.tx.chainId };
        if (s.id === "approve") {
          setStep("Approve the amount in your wallet");
          const hash = await sendTransaction(provider, tx);
          setStep(`Waiting for ${source.name} to confirm the approval`);
          if ((await waitForReceipt(provider, hash, { timeoutMs: 10 * 60_000 })) !== "success") {
            throw new Error(`The approval was reverted on ${source.name}. Nothing was burned.`);
          }
        } else if (s.id === "burn") {
          setStep("Confirm the transfer in your wallet");
          burn = await sendTransaction(provider, tx);
          // From here the burn is out and cannot be recalled.
          setSent({ tx: burn, feePaid: false });
        } else if (s.id === "fee") {
          setStep("Confirm Xebra's fee in your wallet");
          try {
            await sendTransaction(provider, tx);
            feePaid = true;
          } catch (err) {
            console.warn("xebra fee not sent", err);
          }
        }
      }
      if (burn) setSent({ tx: burn, feePaid });
    } catch (err) {
      const text = reportError("evm to stellar failed", err);
      setError({ text, declined: DECLINED.test(text) });
    } finally {
      setStep(null);
    }
  }

  if (sent) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <Notice
          tone={delivery.kind === "stuck" ? "alarm" : "signal"}
          title={
            delivery.kind === "done"
              ? "Delivered on Stellar"
              : delivery.kind === "stuck"
                ? "The mint needs a hand"
                : "Burn submitted"
          }
        >
          {delivery.kind === "done"
            ? "The USDC is in the recipient's Stellar account."
            : delivery.kind === "stuck"
              ? `${delivery.message} The USDC is not lost: anyone holding Circle's attestation can complete the mint, and you can do it from a Stellar wallet for a few hundredths of an XLM.`
              : STANDARD_ETA}
        </Notice>
        <InsetTray className="py-3">
          <span className="tabular block truncate font-mono text-xs text-bone/45">{sent.tx}</span>
        </InsetTray>
        {delivery.kind === "stuck" && (
          <Button
            size="lg"
            disabled={claiming}
            onClick={async () => {
              if (!stellarAddress || !stellarKit) {
                openWallets(["stellar"]);
                return;
              }
              setClaiming(true);
              try {
                const r = await claimOnStellar(stellarKit, stellarAddress, sent.tx, {
                  url: `/api/stellar-inbound/claim?src=${source.cctpDomainId}`,
                  key: "tx",
                });
                setDelivery({ kind: "done", hash: r.hash || null });
              } catch (err) {
                setDelivery({ kind: "stuck", message: reportError("stellar claim failed", err) });
              } finally {
                setClaiming(false);
              }
            }}
          >
            {stellarAddress
              ? "Complete it from your Stellar wallet"
              : "Connect a Stellar wallet to complete it"}
          </Button>
        )}
      </div>
    );
  }

  const canSend = amountOk && recipientOk && quote !== null && step === null;
  return (
    <div className="mt-6 flex flex-col gap-6">
      <Field
        id="evm-stellar-amount"
        label="Amount"
        hint={`USDC on ${source.name}. Xebra's fee comes out of it; at least 1.10 to Stellar.`}
        trailing={<span className="text-xs text-bone/35">USDC</span>}
      >
        <Input
          id="evm-stellar-amount"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="tabular h-12 text-base"
          invalid={amount.trim() !== "" && !amountOk}
          disabled={busy}
        />
      </Field>

      <Field
        id="evm-stellar-recipient"
        label="Stellar address"
        hint="An existing account that already holds a USDC trustline. Starts with G."
        error={
          recipient.trim() !== "" && !recipientOk ? "That is not a Stellar account address." : null
        }
      >
        <Input
          id="evm-stellar-recipient"
          autoComplete="off"
          spellCheck={false}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="G..."
          className="h-12 font-mono text-xs"
          invalid={recipient.trim() !== "" && !recipientOk}
          disabled={busy}
        />
      </Field>

      {quoteError && amountOk && (
        <Notice tone="alarm" title="Cannot price this">
          {quoteError}
        </Notice>
      )}

      {amountOk && !quote && !quoteError && (
        <p className="text-sm text-bone/45" aria-live="polite">
          Pricing this transfer…
        </p>
      )}

      {quote && (
        <InsetTray>
          <dl className="tabular space-y-3">
            <DataRow label="Amount" value={`${quote.amount} USDC`} />
            <DataRow
              label="Delivery"
              value="0 USDC"
              hint="Circle does not deliver into Stellar; Xebra's relayer completes the mint."
            />
            <DataRow label="Xebra fee" value={`−${quote.fees.xebra} USDC`} />
            <div className="pt-3">
              <StripeRule className="mb-3 opacity-50" />
              <DataRow label="Recipient gets" value={`${quote.recipientGets} USDC`} emphasis />
            </div>
          </dl>
        </InsetTray>
      )}

      {step && (
        <Notice tone="info" title="In progress">
          {step}
        </Notice>
      )}
      {error && (
        <Notice
          tone={error.declined ? "info" : "alarm"}
          title={error.declined ? "Wallet request cancelled" : "Could not send"}
        >
          {error.text}
        </Notice>
      )}

      <Button
        size="lg"
        disabled={wallet ? !canSend : false}
        onClick={send}
        trailing={<ArrowRight className="h-4 w-4" />}
      >
        {wallet ? "Send to Stellar" : "Connect an EVM wallet"}
      </Button>
    </div>
  );
}

export type EvmStellarPanelProps = React.ComponentProps<typeof EvmStellarPanel>;
