import Foundation
import AVFoundation
import ShazamKit
import Capacitor

/// Liri — ShazamKit bridge plugin
///
/// findMatch uses SHManagedSession (iOS 17+) — Apple manages audio session and engine internally.
/// waitForSilence uses AVAudioEngine directly for energy monitoring.
@objc(ShazamPlugin)
public class ShazamPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ShazamPlugin"
    public let jsName     = "Shazam"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "findMatch",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "waitForSilence", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel",         returnType: CAPPluginReturnPromise),
    ]

    // MARK: — Match state

    private var matchCall:    CAPPluginCall?
    private var matchTask:    Task<Void, Never>?

    // MARK: — Silence state

    private var silenceEngine:    AVAudioEngine?
    private var silenceCall:      CAPPluginCall?
    private var silenceTimer:     Timer?
    private var silenceGateStart: Date?

    private let silenceThresholdDB: Float  = -40.0
    private let silenceGateSeconds: Double = 3.0

    // MARK: — findMatch

    @objc func findMatch(_ call: CAPPluginCall) {
        call.keepAlive = true
        stopAll()
        matchCall = call

        let timeout = (call.getDouble("timeout") ?? 15000) / 1000.0

        if #available(iOS 17.0, *) {
            AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
                guard let self else { return }
                guard granted else {
                    call.reject("Microphone permission denied")
                    self.matchCall = nil
                    return
                }
                self.startManagedMatch(call: call, timeout: timeout)
            }
        } else {
            // iOS 15–16 fallback using manual SHSession + AVAudioEngine
            AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
                guard let self else { return }
                guard granted else {
                    call.reject("Microphone permission denied")
                    self.matchCall = nil
                    return
                }
                DispatchQueue.main.async { self.startLegacyMatch(call: call, timeout: timeout) }
            }
        }
    }

    // MARK: — SHManagedSession (iOS 17+)

    @available(iOS 17.0, *)
    private func startManagedMatch(call: CAPPluginCall, timeout: Double) {
        let session = SHManagedSession()

        let task = Task { [weak self] in
            guard let self else { return }

            do {
                print("[Shazam] preparing managed session…")
                try await session.prepare()
                print("[Shazam] listening…")

                let result = try await session.result()

                await MainActor.run {
                    guard let pending = self.matchCall else { return }
                    switch result {
                    case .match(let match):
                        guard let item = match.mediaItems.first else {
                            pending.resolve(["matched": false])
                            self.matchCall = nil
                            return
                        }
                        let title  = item.title  ?? ""
                        let artist = item.artist ?? ""
                        let offset = item.predictedCurrentMatchOffset ?? 0
                        let matchTime = Date().timeIntervalSince1970 * 1000 // ms, matches JS Date.now()
                        print("[Shazam] matched: \"\(title)\" by \(artist) at \(String(format: "%.1f", offset))s")
                        pending.resolve(["matched": true, "title": title, "artist": artist, "offset": offset, "matchTime": matchTime])
                        self.matchCall = nil

                    case .noMatch(let sig):
                        print("[Shazam] noMatch — sig duration: \(sig.duration)s")
                        pending.resolve(["matched": false])
                        self.matchCall = nil

                    default:
                        print("[Shazam] error or no match")
                        pending.resolve(["matched": false])
                        self.matchCall = nil
                    }
                }
            } catch {
                print("[Shazam] session error: \(error.localizedDescription)")
                await MainActor.run {
                    self.matchCall?.resolve(["matched": false])
                    self.matchCall = nil
                }
            }
        }

        matchTask = task

        // Timeout — cancel the task and resolve
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self else { return }
            if self.matchCall != nil {
                print("[Shazam] timed out")
                task.cancel()
                session.cancel()
                self.matchCall?.resolve(["matched": false])
                self.matchCall = nil
            }
        }
    }

    // MARK: — SHSession fallback (iOS 15–16)

    private var legacySession: SHSession?
    private var legacyEngine:  AVAudioEngine?
    private var legacyTimer:   Timer?

    private func startLegacyMatch(call: CAPPluginCall, timeout: Double) {
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .default)
            try audioSession.setActive(true)
        } catch {
            call.reject("Audio session error: \(error.localizedDescription)")
            matchCall = nil
            return
        }

        let shazam = SHSession()
        shazam.delegate = self
        legacySession = shazam

        let engine = AVAudioEngine()
        legacyEngine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        print("[Shazam] legacy — format: \(format)")

        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, time in
            self?.legacySession?.matchStreamingBuffer(buffer, at: time)
        }

        do {
            try engine.start()
        } catch {
            stopLegacy()
            call.reject("Engine error: \(error.localizedDescription)")
            matchCall = nil
            return
        }

        legacyTimer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
            guard let self, let pending = self.matchCall else { return }
            print("[Shazam] legacy timed out")
            self.stopLegacy()
            pending.resolve(["matched": false])
            self.matchCall = nil
        }
    }

    // MARK: — SHSessionDelegate (legacy fallback)

    public func session(_ session: SHSession, didFind match: SHMatch) {
        guard let item = match.mediaItems.first, let pending = matchCall else { return }
        let title  = item.title  ?? ""
        let artist = item.artist ?? ""
        var offset: Double = 0
        if #available(iOS 16, *) { offset = item.predictedCurrentMatchOffset ?? 0 }
        let matchTime = Date().timeIntervalSince1970 * 1000
        print("[Shazam] legacy matched: \"\(title)\" by \(artist)")
        stopLegacy()
        pending.resolve(["matched": true, "title": title, "artist": artist, "offset": offset, "matchTime": matchTime])
        matchCall = nil
    }

    public func session(_ session: SHSession, didNotFindMatchFor signature: SHSignature, error: Error?) {
        if let error { print("[Shazam] legacy no match: \(error.localizedDescription)") }
    }

    // MARK: — waitForSilence

    @objc func waitForSilence(_ call: CAPPluginCall) {
        call.keepAlive = true
        stopSilenceEngine()
        silenceCall      = call
        silenceGateStart = nil

        let timeout = (call.getDouble("timeout") ?? 300000) / 1000.0

        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("Microphone permission denied")
                self.silenceCall = nil
                return
            }
            DispatchQueue.main.async { self.startSilenceEngine(timeout: timeout) }
        }
    }

    private func startSilenceEngine(timeout: Double) {
        guard let call = silenceCall else { return }

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .default)
            try audioSession.setActive(true)
        } catch {
            call.reject("Audio session error: \(error.localizedDescription)")
            silenceCall = nil
            return
        }

        let engine = AVAudioEngine()
        silenceEngine = engine
        let input = engine.inputNode
        let hwRate = input.outputFormat(forBus: 0).sampleRate
        let floatFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                        sampleRate: hwRate > 0 ? hwRate : 44100,
                                        channels: 1,
                                        interleaved: false)!

        input.installTap(onBus: 0, bufferSize: 4096, format: floatFormat) { [weak self] buffer, _ in
            guard let self, let data = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<n { sum += data[i] * data[i] }
            let db = n > 0 && sum > 0 ? 20.0 * log10(sqrt(sum / Float(n))) : -160.0

            DispatchQueue.main.async {
                if db < self.silenceThresholdDB {
                    if self.silenceGateStart == nil {
                        self.silenceGateStart = Date()
                    } else if let start = self.silenceGateStart,
                              Date().timeIntervalSince(start) >= self.silenceGateSeconds,
                              let pending = self.silenceCall {
                        print("[Shazam] silence detected")
                        self.stopSilenceEngine()
                        pending.resolve(["silence": true])
                        self.silenceCall = nil
                    }
                } else {
                    self.silenceGateStart = nil
                }
            }
        }

        do {
            try engine.start()
        } catch {
            stopSilenceEngine()
            call.reject("Engine error: \(error.localizedDescription)")
            silenceCall = nil
            return
        }

        silenceTimer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
            guard let self, let pending = self.silenceCall else { return }
            self.stopSilenceEngine()
            pending.resolve(["silence": false])
            self.silenceCall = nil
        }
    }

    // MARK: — cancel

    @objc func cancel(_ call: CAPPluginCall) {
        stopAll()
        call.resolve()
    }

    // MARK: — Cleanup

    private func stopLegacy() {
        legacyTimer?.invalidate()
        legacyTimer = nil
        legacyEngine?.inputNode.removeTap(onBus: 0)
        legacyEngine?.stop()
        legacyEngine  = nil
        legacySession = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func stopSilenceEngine() {
        silenceTimer?.invalidate()
        silenceTimer     = nil
        silenceEngine?.inputNode.removeTap(onBus: 0)
        silenceEngine?.stop()
        silenceEngine    = nil
        silenceGateStart = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func stopAll() {
        matchTask?.cancel()
        matchTask = nil
        if let pending = matchCall   { pending.resolve(["matched": false]);  matchCall  = nil }
        if let pending = silenceCall { pending.resolve(["silence": false]); silenceCall = nil }
        stopLegacy()
        stopSilenceEngine()
    }
}

// MARK: — SHSessionDelegate conformance (legacy)
extension ShazamPlugin: SHSessionDelegate {}
