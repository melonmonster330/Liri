import Foundation
import Capacitor
import StoreKit

/// Liri — StoreKit 2 In-App Purchase bridge
///
/// Product: com.getliri.app.premium.monthly (auto-renewable subscription)
/// Requires iOS 15+
@objc(LiriIAPPlugin)
public class LiriIAPPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier  = "LiriIAPPlugin"
    public let jsName      = "LiriIAP"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "fetchProduct",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase",              returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSubscriptionStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases",      returnType: CAPPluginReturnPromise),
    ]

    private let productId = "com.getliri.app.premium.monthly"

    // MARK: — fetchProduct
    // Returns price string and display name so JS can show the correct price.

    @objc func fetchProduct(_ call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("Product not found — check App Store Connect product ID")
                    return
                }
                call.resolve([
                    "productId":    product.id,
                    "title":        product.displayName,
                    "description":  product.description,
                    "displayPrice": product.displayPrice,   // e.g. "$5.99"
                ])
            } catch {
                call.reject("fetchProduct error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: — purchase
    // Presents the native App Store sheet. On success returns the signed JWS
    // transaction string, which must be sent to /api/stripe-checkout for
    // server-side verification before granting premium access.

    @objc func purchase(_ call: CAPPluginCall) {
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
    // Checks current entitlements from StoreKit. Returns isActive + signed JWS
    // so the server can sync the subscription state on every app launch.

    @objc func getSubscriptionStatus(_ call: CAPPluginCall) {
        Task {
            var isActive          = false
            var signedTransaction: String? = nil

            for await result in Transaction.currentEntitlements {
                if case .verified(let tx) = result, tx.productID == productId {
                    let notExpired = tx.expirationDate.map { $0 > Date() } ?? true
                    if notExpired {
                        isActive          = true
                        signedTransaction = result.jwsRepresentation
                        break
                    }
                }
            }

            call.resolve([
                "isActive":          isActive,
                "signedTransaction": signedTransaction as Any,
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

                var isActive          = false
                var signedTransaction: String? = nil

                for await result in Transaction.currentEntitlements {
                    if case .verified(let tx) = result, tx.productID == productId {
                        let notExpired = tx.expirationDate.map { $0 > Date() } ?? true
                        if notExpired {
                            isActive          = true
                            signedTransaction = result.jwsRepresentation
                            break
                        }
                    }
                }

                call.resolve([
                    "isActive":          isActive,
                    "signedTransaction": signedTransaction as Any,
                ])
            } catch {
                call.reject("Restore error: \(error.localizedDescription)")
            }
        }
    }
}
