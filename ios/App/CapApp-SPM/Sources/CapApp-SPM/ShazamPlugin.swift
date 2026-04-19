import Foundation
import AVFoundation
import ShazamKit
import Capacitor

/// ShazamKit audio fingerprinting plugin for Liri.
///
/// Uses the same promise-based pattern as NativeAudioPlugin — no event listeners,
/// just a long-running promise that resolves when a match is found or cancelled.
///
/// JS usage:
///   // Find song + position (resolves with { matched, title, artist, offset } or { matched: false })
///   const result = await Capacitor.Plugins.Shazam.findMatch({ timeout: 15000 });
///
///   // Monitor for silence gaps between tracks (resolves with { silence: true } or { silence: false })
///   const gap = await Capacitor.Plugins.Shazam.waitForSilence({ timeout: 300000 });
///
///   // Cancel either of the above
///   await Capacitor.Plugins.Shazam.cancel();
@objc(ShazamPlugin)
public class ShazamPlugin: CAPPlugin, CAPBridgedPlugin, SHSessionDelegate {

    public let identifier = "ShazamPlugin"
    public let jsName = "Shazam"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "findMatch",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "waitForSilence", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel",         returnType: CAPPluginReturnPromise),
    ]

    // Safe PCM format: 44.1 kHz mono float32 — installTap auto-converts from hardware format.
    // Using a fixed format avoids the sampleRate=0 crash from outputFormat(forBus:) before engine start.
    private let tapFormat = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!

    // ── Shazam matching state ──
    private var shazamSession: SHSession?
    private var matchEngine: AVAudioEngine?
    private var matchCall: CAPPluginCall?
    private var matchTimer: Timer?

    // ── Silence detection state ──
    private var silenceEngine: AVAudioEngine?
    private var silenceCall: CAPPluginCall?
    private var silenceTimer: Timer?
    private var silenceFrameCount = 0
    private let silenceThreshold: Float = 0.015  // RMS below this = silence
    private let silenceFramesNeeded = 15          // ~1.5s of 100ms chunks

    // MARK: – findMatch

    @objc func findMatch(_ call: CAPPluginCall) {
        call.keepAlive = true   // long-running promise — prevent Capacitor from GC-ing the call
        cancelAll()
        let timeoutMs = call.getDouble("timeout") ?? 15000
        matchCall = call

        // Request microphone permission first if needed
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            guard let self = self else { return }
            guard granted else {
                call.reject("Microphone permission denied")
                self.matchCall = nil
                return
            }
            DispatchQueue.main.async { self.startMatchEngine(call: call, timeoutMs: timeoutMs) }
        }
    }

    private func startMatchEngine(call: CAPPluginCall, timeoutMs: Double) {
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement)
            try audioSession.setActive(true)
        } catch {
            call.reject("Audio session error: \(error.localizedDescription)")
            matchCall = nil
            return
        }

        let session = SHSession()
        session.delegate = self
        shazamSession = session

        let engine = AVAudioEngine()
        matchEngine = engine
        let inputNode = engine.inputNode

        // Use fixed format — installTap performs the conversion from hardware format automatically.
        inputNode.installTap(onBus: 0, bufferSize: 8192, format: tapFormat) { [weak self] buffer, time in
            self?.shazamSession?.matchStreamingBuffer(buffer, at: time)
        }

        do {
            try engine.start()
        } catch {
            stopMatchEngine()
            call.reject("Audio engine error: \(error.localizedDescription)")
            matchCall = nil
            return
        }

        // Timeout — resolve with matched:false so JS can show track list
        matchTimer = Timer.scheduledTimer(withTimeInterval: timeoutMs / 1000, repeats: false) { [weak self] _ in
            guard let self = self, let pending = self.matchCall else { return }
            self.stopMatchEngine()
            pending.resolve(["matched": false])
            self.matchCall = nil
        }
    }

    // MARK: – SHSessionDelegate

    public func session(_ session: SHSession, didFind match: SHMatch) {
        guard let item = match.mediaItems.first, let pending = matchCall else { return }
        matchTimer?.invalidate()
        matchTimer = nil

        let title     = item.title  ?? ""
        let artist    = item.artist ?? ""
        let matchTime = Date().timeIntervalSince1970 * 1000  // ms for JS elapsed calc

        // predictedCurrentMatchOffset available iOS 16+; fall back to 0 on iOS 15
        var offset: Double = 0
        if #available(iOS 16.0, *) {
            offset = item.predictedCurrentMatchOffset ?? 0
        }

        stopMatchEngine()
        pending.resolve([
            "matched":   true,
            "title":     title,
            "artist":    artist,
            "offset":    offset,
            "matchTime": matchTime,
        ])
        matchCall = nil
    }

    public func session(_ session: SHSession, didNotFindMatchFor signature: SHSignature, error: Error?) {
        // Not fatal — Shazam tries multiple times; we let the timer decide when to give up
    }

    // MARK: – waitForSilence

    @objc func waitForSilence(_ call: CAPPluginCall) {
        call.keepAlive = true   // long-running promise
        stopSilenceEngine()
        silenceFrameCount = 0
        silenceCall = call
        let timeoutMs = call.getDouble("timeout") ?? 300000

        AVAudioApplication.requestRecordPermission { [weak self] granted in
            guard let self = self else { return }
            guard granted else {
                call.reject("Microphone permission denied")
                self.silenceCall = nil
                return
            }
            DispatchQueue.main.async { self.startSilenceEngine(call: call, timeoutMs: timeoutMs) }
        }
    }

    private func startSilenceEngine(call: CAPPluginCall, timeoutMs: Double) {
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement)
            try audioSession.setActive(true)
        } catch {
            call.reject("Audio session error: \(error.localizedDescription)")
            silenceCall = nil
            return
        }

        let engine = AVAudioEngine()
        silenceEngine = engine
        let inputNode = engine.inputNode

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: tapFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            let n = Int(buffer.frameLength)
            guard n > 0, let ch = buffer.floatChannelData?[0] else { return }
            var sum: Float = 0
            for i in 0..<n { sum += ch[i] * ch[i] }
            let rms = sqrt(sum / Float(n))
            DispatchQueue.main.async {
                if rms < self.silenceThreshold {
                    self.silenceFrameCount += 1
                    if self.silenceFrameCount == self.silenceFramesNeeded,
                       let pending = self.silenceCall {
                        self.stopSilenceEngine()
                        pending.resolve(["silence": true])
                        self.silenceCall = nil
                    }
                } else {
                    self.silenceFrameCount = 0
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

        silenceTimer = Timer.scheduledTimer(withTimeInterval: timeoutMs / 1000, repeats: false) { [weak self] _ in
            guard let self = self, let pending = self.silenceCall else { return }
            self.stopSilenceEngine()
            pending.resolve(["silence": false])
            self.silenceCall = nil
        }
    }

    // MARK: – cancel

    @objc func cancel(_ call: CAPPluginCall) {
        cancelAll()
        call.resolve()
    }

    // MARK: – Helpers

    private func stopMatchEngine() {
        matchEngine?.inputNode.removeTap(onBus: 0)
        matchEngine?.stop()
        matchEngine = nil
        shazamSession = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func stopSilenceEngine() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        silenceEngine?.inputNode.removeTap(onBus: 0)
        silenceEngine?.stop()
        silenceEngine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func cancelAll() {
        matchTimer?.invalidate()
        matchTimer = nil
        if let pending = matchCall {
            pending.resolve(["matched": false])
            matchCall = nil
        }
        stopMatchEngine()

        if let pending = silenceCall {
            pending.resolve(["silence": false])
            silenceCall = nil
        }
        stopSilenceEngine()
    }
}
