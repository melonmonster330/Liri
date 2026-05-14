import Foundation
import Capacitor
import StoreKit

/// Liri — StoreKit 2 In-App Purchase bridge
///
/// Products:
///   com.getliri.app.premium.monthly  — auto-renewable subscription
///   com.getliri.app.lifetime         — non-consumable (one-time purchase)
///
/// Requires iOS 15+
@objc(LiriIAPPlugin)
public class LiriIAPPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier  = "LiriIAPPlugin"
    public let jsName      = "LiriIAP"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "fetchProduct",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchLifetimeProduct",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase",              returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchaseLifetime",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSubscriptionStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases",      returnType: CAPPluginReturnPromise),
    ]

    private let monthlyProductId  = "com.getliri.app.premium.monthly"
    private let lifetimeProductId = "com.getliri.app.lifetime"

    // MARK: — fetchProduct / fetchLifetimeProduct
    // Returns price string and display name so JS can show the correct price.

    @objc func fetchProduct(_ call: CAPPluginCall) {
        fetchProductInternal(productId: monthlyProductId, call: call)
    }

    @objc func fetchLifetimeProduct(_ call: CAPPluginCall) {
        fetchProductInternal(productId: lifetimeProductId, call: call)
    }

    private func fetchProductInternal(productId: String, call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("Product not found — check App Store Connect product ID: \(productId)")
                    return
                }
                call.resolve([
                    "productId":    product.id,
                    "title":        product.displayName,
                    "description":  product.description,
                    "displayPrice": product.displayPrice,
                ])
            } catch {
                call.reject("fetchProduct error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: — purchase / purchaseLifetime
    // Presents the native App Store sheet. On success returns the signed JWS
    // transaction string, which must be sent to /api/stripe-checkout for
    // server-side verification before granting premium access.

    @objc func purchase(_ call: CAPPluginCall) {
        purchaseInternal(productId: monthlyProductId, call: call)
    }

    @objc func purchaseLifetime(_ call: CAPPluginCall) {
        purchaseInternal(productId: lifetimeProductId, call: call)
    }

    private func purchaseInternal(productId: String, call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("Product not found")
                    return
                }

                let result = try await product.purchase()

                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        await transaction.finish()
                        call.resolve([
                            "transactionId":     String(transaction.id),
                            "signedTransaction": verification.jwsRepresentation,
                            "productId":         product.id,
                        ])
                    case .unverified(_, let error):
                        call.reject("Transaction unverified: \(error.localizedDescription)")
                    }
                case .userCancelled:
                    call.reject("cancelled")
                case .pending:
                    call.reject("pending")
                @unknown default:
                    call.reject("Unknown purchase result")
                }
            } catch {
                call.reject("Purchase error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: — getSubscriptionStatus
    // Checks current entitlements from StoreKit. Surfaces whichever entitlement
    // grants premium access: an active monthly subscription OR a lifetime
    // non-consumable purchase. Lifetime is preferred when both exist.

    @objc func getSubscriptionStatus(_ call: CAPPluginCall) {
        Task {
            let entitlement = await currentPremiumEntitlement()
            call.resolve([
                "isActive":          entitlement.isActive,
                "signedTransaction": entitlement.signedTransaction as Any,
                "productId":         entitlement.productId as Any,
                "isLifetime":        entitlement.productId == lifetimeProductId,
            ])
        }
    }

    // MARK: — restorePurchases
    // Forces a sync with the App Store then re-checks entitlements.
    // Show a "Restore Purchases" button in settings for users who reinstall.

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
                let entitlement = await currentPremiumEntitlement()
                call.resolve([
                    "isActive":          entitlement.isActive,
                    "signedTransaction": entitlement.signedTransaction as Any,
                    "productId":         entitlement.productId as Any,
                    "isLifetime":        entitlement.productId == lifetimeProductId,
                ])
            } catch {
                call.reject("Restore error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: — Shared entitlement check

    private struct Entitlement {
        let isActive: Bool
        let signedTransaction: String?
        let productId: String?
    }

    /// Walks Transaction.currentEntitlements. Lifetime non-consumable wins over
    /// monthly subscription when both are present.
    private func currentPremiumEntitlement() async -> Entitlement {
        var monthlyActive = false
        var monthlyJWS:    String? = nil

        for await result in Transaction.currentEntitlements {
            guard case .verified(let tx) = result else { continue }

            if tx.productID == lifetimeProductId {
                // Non-consumables don't expire — if it's in current entitlements, it's owned.
                return Entitlement(isActive: true,
                                   signedTransaction: result.jwsRepresentation,
                                   productId: lifetimeProductId)
            }

            if tx.productID == monthlyProductId {
                let notExpired = tx.expirationDate.map { $0 > Date() } ?? true
                if notExpired {
                    monthlyActive = true
                    monthlyJWS    = result.jwsRepresentation
                }
            }
        }

        return Entitlement(isActive: monthlyActive,
                           signedTransaction: monthlyJWS,
                           productId: monthlyActive ? monthlyProductId : nil)
    }
}
