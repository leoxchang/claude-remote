import AVFoundation
import Flutter
import UIKit

/// 把 AVAudioSession 中断事件上报给 Dart；不恢复录音、不读取音频。
final class AudioInterruptionBridge {
  static let channelName = "claude_remote/s05_audio_interruption"

  private static var channel: FlutterEventChannel?
  private static let handler = AudioInterruptionHandler()

  static func register(messenger: FlutterBinaryMessenger) {
    let eventChannel = FlutterEventChannel(
      name: channelName,
      binaryMessenger: messenger
    )
    eventChannel.setStreamHandler(handler)
    channel = eventChannel
  }
}

private final class AudioInterruptionHandler: NSObject, FlutterStreamHandler {
  private var sink: FlutterEventSink?
  private var observer: NSObjectProtocol?

  func onListen(
    withArguments arguments: Any?,
    eventSink events: @escaping FlutterEventSink
  ) -> FlutterError? {
    sink = events
    observer = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] notification in
      guard
        let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey]
          as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: raw)
      else {
        return
      }
      // ended 只上报事件；Dart 侧不会自动恢复录音。
      self?.sink?(type == .began ? "began" : "ended")
    }
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    if let observer {
      NotificationCenter.default.removeObserver(observer)
    }
    observer = nil
    sink = nil
    return nil
  }
}