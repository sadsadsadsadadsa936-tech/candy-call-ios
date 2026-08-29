import Foundation
import AVFoundation
import AudioToolbox

/// Native WebSocket + AVAudioEngine – komplett ohne WKWebView für Telefon-Audio
final class CallAudioManager {
    static let shared = CallAudioManager()

    private var wsTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var captureEngine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var callId: String?
    private var token: String?
    private var apiBase: String?
    private var running = false
    private var paused = false
    private let targetSampleRate: Double = 16000
    private var framesReceived = 0

    func start(apiBase: String, token: String, callId: String) {
        stop()
        self.apiBase = apiBase
        self.token = token
        self.callId = callId
        self.running = true
        self.paused = false
        self.framesReceived = 0

        configureAudioSession()
        NativePcmPlayer.shared.prepare(sampleRate: targetSampleRate)
        startMicCapture()
        connectWebSocket()
    }

    func stop() {
        running = false
        paused = false
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        captureEngine?.inputNode.removeTap(onBus: 0)
        captureEngine?.stop()
        captureEngine = nil
        converter = nil
        NativePcmPlayer.shared.stop()
        callId = nil
        token = nil
    }

    func pause() {
        paused = true
        captureEngine?.inputNode.removeTap(onBus: 0)
    }

    func resume(apiBase: String, token: String, callId: String) {
        if running && !paused { return }
        if !running {
            start(apiBase: apiBase, token: token, callId: callId)
            return
        }
        paused = false
        startMicCapture()
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            try session.setActive(true)
            try session.overrideOutputAudioPort(.speaker)
        } catch {
            print("[CallAudio] session error: \(error.localizedDescription)")
        }
    }

    private func connectWebSocket() {
        guard var base = apiBase else { return }
        if base.hasSuffix("/") { base.removeLast() }
        base = base.replacingOccurrences(of: "https://", with: "wss://")
        base = base.replacingOccurrences(of: "http://", with: "ws://")
        guard let url = URL(string: base + "/api/candy-call/ws") else { return }

        urlSession = URLSession(configuration: .default)
        wsTask = urlSession?.webSocketTask(with: url)
        wsTask?.resume()

        sendJSON([
            "type": "agent_audio_link",
            "token": token ?? "",
            "callId": callId ?? ""
        ])
        listen()
    }

    private func listen() {
        wsTask?.receive { [weak self] result in
            guard let self, self.running else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                self.listen()
            case .failure(let error):
                print("[CallAudio] receive error: \(error.localizedDescription)")
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {
        case "audio_pcm":
            guard !paused, let b64 = obj["d"] as? String else { return }
            let sr = (obj["sr"] as? NSNumber)?.doubleValue ?? targetSampleRate
            framesReceived += 1
            NativePcmPlayer.shared.enqueue(base64: b64, sampleRate: sr)
        case "audio_link_ready":
            NativePcmPlayer.shared.playConfirmBeep()
        case "call_ended", "call_hold":
            pause()
        case "call_resume":
            if let cid = obj["callId"] as? String ?? callId,
               let tok = token, let base = apiBase {
                resume(apiBase: base, token: tok, callId: cid)
            }
        default:
            break
        }
    }

    private func sendJSON(_ dict: [String: Any]) {
        guard running, !paused, let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(str)) { error in
            if let error {
                print("[CallAudio] send error: \(error.localizedDescription)")
            }
        }
    }

    private func startMicCapture() {
        captureEngine?.inputNode.removeTap(onBus: 0)
        captureEngine?.stop()

        let engine = AVAudioEngine()
        captureEngine = engine
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)

        targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: true
        )
        guard let targetFormat else { return }
        converter = AVAudioConverter(from: inFormat, to: targetFormat)

        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
            self?.processMicBuffer(buffer)
        }

        do {
            try engine.start()
        } catch {
            print("[CallAudio] mic engine error: \(error.localizedDescription)")
        }
    }

    private func processMicBuffer(_ buffer: AVAudioPCMBuffer) {
        guard running, !paused, let converter, let targetFormat, let callId else { return }

        let ratio = targetSampleRate / buffer.format.sampleRate
        let outCapacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio)) + 256
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCapacity) else { return }

        var consumed = false
        var convError: NSError?
        let status = converter.convert(to: outBuf, error: &convError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, outBuf.frameLength > 0, let ch = outBuf.int16ChannelData?[0] else { return }

        let bytes = Data(bytes: ch, count: Int(outBuf.frameLength) * 2)
        sendJSON([
            "type": "audio_pcm",
            "callId": callId,
            "sr": Int(targetSampleRate),
            "d": bytes.base64EncodedString()
        ])
    }
}

final class NativePcmPlayer {
    static let shared = NativePcmPlayer()
    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private var format: AVAudioFormat?
    private var started = false
    private var scheduled = 0

    func prepare(sampleRate: Double = 16000) {
        if started { return }
        let fmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
        format = fmt
        if engine.attachedNodes.isEmpty || !engine.attachedNodes.contains(playerNode) {
            engine.attach(playerNode)
            engine.connect(playerNode, to: engine.mainMixerNode, format: fmt)
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            try session.setActive(true)
            try session.overrideOutputAudioPort(.speaker)
            if !engine.isRunning { try engine.start() }
            if !playerNode.isPlaying { playerNode.play() }
            started = true
        } catch {
            print("[NativePcmPlayer] prepare: \(error.localizedDescription)")
        }
    }

    func enqueue(base64: String, sampleRate: Double = 16000) {
        if !started { prepare(sampleRate: sampleRate) }
        guard started, let fmt = format, let data = Data(base64Encoded: base64), data.count >= 2 else { return }

        let frameCount = AVAudioFrameCount(data.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frameCount) else { return }
        buffer.frameLength = frameCount
        data.withUnsafeBytes { raw in
            guard let src = raw.baseAddress, let dst = buffer.int16ChannelData?[0] else { return }
            memcpy(dst, src, data.count)
        }
        scheduled += 1
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
    }

    func playConfirmBeep() {
        AudioServicesPlaySystemSound(1052)
    }

    func stop() {
        playerNode.stop()
        if engine.isRunning { engine.stop() }
        started = false
        scheduled = 0
    }
}
