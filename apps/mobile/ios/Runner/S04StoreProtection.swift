import Flutter
import UIKit

/// 为 RecoveryStore 的 DB/WAL/SHM 设置并验证 iOS Data Protection。
final class S04StoreProtection {
  static let channelName = "claude_remote/s04_store_protection"

  /// 注册最小方法通道；Dart 只传数据库路径，正文不经过通道。
  static func register(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(
      name: channelName,
      binaryMessenger: messenger
    )
    channel.setMethodCallHandler { call, result in
      guard call.method == "protectDatabase" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard
        let arguments = call.arguments as? [String: Any],
        let databasePath = arguments["databasePath"] as? String
      else {
        result(
          FlutterError(
            code: "INVALID_ARGUMENT",
            message: "databasePath is required",
            details: nil
          )
        )
        return
      }
      do {
        result(try setAndVerify(databasePath: databasePath))
      } catch {
        result(
          FlutterError(
            code: "PROTECTION_FAILED",
            message: "Data Protection could not be verified",
            details: nil
          )
        )
      }
    }
  }

  /// 对存在的 DB/WAL/SHM 设置 NSFileProtectionComplete 并逐一回读验证。
  static func setAndVerify(databasePath: String) throws -> [String: Any] {
    let manager = FileManager.default
    var files: [[String: String]] = []
    for suffix in ["", "-wal", "-shm"] {
      let path = databasePath + suffix
      var isDirectory: ObjCBool = false
      guard manager.fileExists(atPath: path, isDirectory: &isDirectory) else {
        continue
      }
      if isDirectory.boolValue {
        continue
      }
      try manager.setAttributes(
        [.protectionKey: FileProtectionType.complete],
        ofItemAtPath: path
      )
      let attributes = try manager.attributesOfItem(atPath: path)
      let protection =
        (attributes[.protectionKey] as? String)
        ?? (attributes[.protectionKey] as? FileProtectionType)?.rawValue
      guard protection == FileProtectionType.complete.rawValue else {
        throw NSError(domain: channelName, code: 1)
      }
      files.append(["suffix": suffix, "protection": "complete"])
    }
    guard !files.isEmpty else {
      throw NSError(domain: channelName, code: 2)
    }
    return ["protected": true, "files": files]
  }
}