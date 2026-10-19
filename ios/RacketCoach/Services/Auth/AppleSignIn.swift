import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

/// Nonce for Sign in with Apple + Supabase (DESIGN.md §5.2 Auth): Apple gets the SHA-256 hex of a random string,
/// Supabase gets the raw string and hashes it again to compare with the token's `nonce` claim.
struct AppleNonce: Sendable, Hashable {
    let raw: String

    var sha256: String { AppleNonce.sha256Hex(raw) }

    /// `length` random characters (SecRandomCopyBytes) from the RFC 3986 unreserved alphabet.
    static func make(length: Int = 32) -> AppleNonce {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        result.reserveCapacity(length)
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // Practically unreachable; fall back to the system RNG rather than crashing.
            for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        }
        for byte in bytes {
            result.append(charset[Int(byte) % charset.count])
        }
        return AppleNonce(raw: result)
    }

    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Errors specific to the Apple sheet.
enum AppleSignInError: Error, Equatable {
    /// The user closed the sheet: not an error to show.
    case cancelled
    /// Apple returned no identity token (should not happen).
    case missingToken
    case failed(String)
}

/// Builds an `AppleCredential` from a finished authorization. Works for `SignInWithAppleButton`'s `onCompletion` too:
///
/// ```swift
/// @State private var nonce = AppleNonce.make()
/// SignInWithAppleButton(.continue) { request in
///     AppleSignIn.configure(request, nonce: nonce)
/// } onCompletion: { result in
///     let credential = try AppleSignIn.credential(from: result.get(), nonce: nonce)
///     let outcome = try await deps.linker.linkApple(credential)
/// }
/// ```
enum AppleSignIn {
    /// Scopes and hashed nonce for the request.
    static func configure(_ request: ASAuthorizationAppleIDRequest, nonce: AppleNonce) {
        request.requestedScopes = [.email]
        request.nonce = nonce.sha256
    }

    static func credential(from authorization: ASAuthorization, nonce: AppleNonce) throws -> AppleCredential {
        guard let apple = authorization.credential as? ASAuthorizationAppleIDCredential else {
            throw AppleSignInError.failed("unexpected credential type")
        }
        guard let tokenData = apple.identityToken, let idToken = String(data: tokenData, encoding: .utf8) else {
            throw AppleSignInError.missingToken
        }
        let code = apple.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        return AppleCredential(idToken: idToken, rawNonce: nonce.raw, authorizationCode: code, email: apple.email)
    }

    /// Maps `ASAuthorizationError.canceled` to `.cancelled`.
    static func map(_ error: Error) -> Error {
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            return AppleSignInError.cancelled
        }
        return error
    }

    /// Runs the Apple sheet from code (no SwiftUI button) and returns the credential.
    @MainActor
    static func requestCredential() async throws -> AppleCredential {
        let nonce = AppleNonce.make()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        configure(request, nonce: nonce)
        let coordinator = AppleSignInCoordinator()
        let authorization = try await coordinator.perform(request)
        return try credential(from: authorization, nonce: nonce)
    }
}

/// `ASAuthorizationController` delegate bridged to async/await.
@MainActor
final class AppleSignInCoordinator: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    func perform(_ request: ASAuthorizationAppleIDRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        MainActor.assumeIsolated {
            continuation?.resume(returning: authorization)
            continuation = nil
            self.controller = nil
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            continuation?.resume(throwing: AppleSignIn.map(error))
            continuation = nil
            self.controller = nil
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
            return window ?? ASPresentationAnchor()
        }
    }
}
