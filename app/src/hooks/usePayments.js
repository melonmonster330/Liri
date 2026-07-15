// usePayments — subscription tier + Apple IAP + Stripe upgrade flow.
// Owns: userTier, albumCount, upgradeWorking, iapPrice, premiumPlan, iapWorking.
// Takes sb (Supabase client) and sessionTokenRef (owned by the caller — the
// same ref used for all other Authorization headers) as args, per the
// refactor guardrail that a ref must have exactly one owner.

import { getLiriIAP } from "../../ios/iap.js";
import { IS_IOS } from "../../base/lib/config.js";

const { useState, useEffect } = React;

export function usePayments({ sb, sessionTokenRef }) {
  // ── Subscription tier — fetched from /api/subscription-status on login ──
  const [userTier, setUserTier]       = useState("free"); // "free" | "premium"
  const [albumCount, setAlbumCount]   = useState(0);
  const [upgradeWorking, setUpgradeWorking] = useState(false);

  // ── Apple IAP ─────────────────────────────────────────────────────────────
  const [iapPrice,   setIapPrice]   = useState("$2.99/mo"); // overwritten by iap.fetchProduct() on mount
  const [premiumPlan, setPremiumPlan] = useState("monthly"); // "monthly" | "lifetime"
  const [iapWorking, setIapWorking] = useState(false);

  // Fetch live price from App Store on iOS (best-effort)
  useEffect(() => {
    const iap = getLiriIAP();
    if (!IS_IOS || !iap) return;
    iap.fetchProduct()
      .then(p => { if (p?.displayPrice) setIapPrice(`${p.displayPrice}/mo`); })
      .catch(() => {});
  }, []);

  // On iOS login, check for an active Apple subscription and sync with server
  const syncAppleSubscription = async (token) => {
    const iap = getLiriIAP();
    if (!IS_IOS || !iap) return;
    try {
      const status = await iap.getSubscriptionStatus();
      if (status?.isActive && status?.signedTransaction) {
        const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ appleTransaction: status.signedTransaction }),
        });
        if (r.ok) setUserTier("premium");
      }
    } catch {}
  };

  // plan: "monthly" (renewable sub) | "lifetime" (non-consumable)
  const upgradeWithApple = async (plan = "monthly") => {
    const iap = getLiriIAP();
    if (!iap) {
      alert("In-app purchases are not available right now. Please try again or contact support.");
      return;
    }
    setIapWorking(true);
    try {
      const result = plan === "lifetime"
        ? await iap.purchaseLifetime()
        : await iap.purchase();
      if (result?.signedTransaction) {
        const token = sessionTokenRef.current;
        const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ appleTransaction: result.signedTransaction, plan }),
        });
        const data = await r.json();
        if (data.tier === "premium" || data.tier === "lifetime") {
          setUserTier(data.tier);
          setAlbumCount(prev => prev); // keep count, limit lifted
        } else {
          alert(data.error || "Could not verify purchase. Please contact support.");
        }
      }
    } catch (e) {
      if (e?.message !== "cancelled") alert("Purchase failed. Please try again.");
    } finally {
      setIapWorking(false);
    }
  };

  const restoreApplePurchases = async () => {
    const iap = getLiriIAP();
    if (!iap) { alert("Restore is not available right now."); return; }
    setIapWorking(true);
    try {
      const status = await iap.restorePurchases();
      if (status?.isActive && status?.signedTransaction) {
        const token = sessionTokenRef.current;
        // restorePurchases tells us which product is active; pass the matching plan.
        const plan = status.isLifetime ? "lifetime" : "monthly";
        const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ appleTransaction: status.signedTransaction, plan }),
        });
        const data = await r.json();
        if (data.tier === "premium" || data.tier === "lifetime") setUserTier(data.tier);
        else alert("No active subscription found.");
      } else {
        alert("No active subscription found.");
      }
    } catch { alert("Restore failed. Please try again."); }
    finally { setIapWorking(false); }
  };

  // ── Upgrade via Stripe Checkout (web) ──
  // plan: "monthly" (recurring) | "lifetime" (one-time)
  const upgradeToStripe = async (plan = "monthly") => {
    setUpgradeWorking(true);
    try {
      const { data: { session: s } } = await sb.auth.getSession();
      const token = s?.access_token || sessionTokenRef.current;
      const res  = await fetch("/api/stripe-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.url) { window.location.href = json.url; }
      else { alert(json.error || "Could not start checkout. Please try again."); setUpgradeWorking(false); }
    } catch { alert("Network error — please try again."); setUpgradeWorking(false); }
  };

  return {
    userTier, setUserTier,
    albumCount, setAlbumCount,
    upgradeWorking, setUpgradeWorking,
    iapPrice, setIapPrice,
    premiumPlan, setPremiumPlan,
    iapWorking, setIapWorking,
    syncAppleSubscription,
    upgradeWithApple,
    restoreApplePurchases,
    upgradeToStripe,
  };
}
