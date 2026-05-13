// JS bridge to the native LiriIAP Capacitor plugin
// (ios/App/CapApp-SPM/Sources/CapApp-SPM/LiriIAPPlugin.swift).
//
// Apple In-App Purchase: subscription product fetch, purchase, restore,
// and subscription-status checks. Returns null on web — callers must
// branch on the return value.
//
// Lazy getter: window.Capacitor isn't ready at module-load time on iOS —
// the bridge is injected after the JS parses — so re-check on every call.
//
// Methods exposed by the native plugin (call as getLiriIAP()?.fetchProduct() etc):
//   fetchProduct()             → { productId, displayPrice, ... } | null
//   purchase()                 → { signedTransaction, ... } | error
//   restorePurchases()         → { signedTransaction, ... } | null
//   getSubscriptionStatus()    → { active: bool, signedTransaction?, expirationDate? }

export function getLiriIAP() {
  return window.Capacitor?.Plugins?.LiriIAP ?? null;
}
