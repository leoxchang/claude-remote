import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'credential_store.dart';

/// 允许上传的图片类型；与 Mac 端白名单一致。
const Set<String> supportedImageMediaTypes = {
  'image/jpeg',
  'image/png',
  'image/webp',
};

/// Mac 认可的图片引用；只包含不透明 id，不含本机路径。
final class UploadedAttachment {
  const UploadedAttachment({
    required this.attachmentId,
    required this.mediaType,
    required this.size,
  });

  final String attachmentId;
  final String mediaType;
  final int size;

  Map<String, Object?> toWire() {
    return {
      'attachmentId': attachmentId,
      'mediaType': mediaType,
      'size': size,
    };
  }
}

/// 上传失败；code 是本地校验或 Mac 返回的稳定错误码。
final class AttachmentUploadException implements Exception {
  const AttachmentUploadException(this.code);

  final String code;

  @override
  String toString() => 'AttachmentUploadException($code)';
}

/// HTTP 响应子集；测试注入内存实现。
final class AttachmentUploadResponse {
  const AttachmentUploadResponse({
    required this.statusCode,
    required this.body,
  });

  final int statusCode;
  final String body;
}

/// 可注入的 HTTP 传输。
abstract interface class AttachmentTransport {
  Future<AttachmentUploadResponse> post(
    Uri uri,
    Map<String, String> headers,
    String body,
  );
}

/// 真实 HTTP 传输；token 只在 Authorization header。
final class HttpAttachmentTransport implements AttachmentTransport {
  HttpAttachmentTransport({http.Client? client})
    : _client = client ?? http.Client();

  final http.Client _client;

  @override
  Future<AttachmentUploadResponse> post(
    Uri uri,
    Map<String, String> headers,
    String body,
  ) async {
    final response = await _client.post(uri, headers: headers, body: body);
    return AttachmentUploadResponse(
      statusCode: response.statusCode,
      body: response.body,
    );
  }
}

/// 按图片魔数判断 media type；无法识别时返回 null。
String? imageMediaTypeForBytes(List<int> bytes) {
  if (bytes.length > 3 &&
      bytes[0] == 0xff &&
      bytes[1] == 0xd8 &&
      bytes[2] == 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length > 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4e &&
      bytes[3] == 0x47 &&
      bytes[4] == 0x0d &&
      bytes[5] == 0x0a &&
      bytes[6] == 0x1a &&
      bytes[7] == 0x0a) {
    return 'image/png';
  }
  if (bytes.length > 12 &&
      ascii.decode(bytes.sublist(0, 4), allowInvalid: true) == 'RIFF' &&
      ascii.decode(bytes.sublist(8, 12), allowInvalid: true) == 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/// 把本机图片上传到 Mac；失败时只暴露稳定错误码。
final class AttachmentApi {
  const AttachmentApi({
    required this.credentials,
    required this.transport,
  });

  final CredentialStore credentials;
  final AttachmentTransport transport;

  Future<UploadedAttachment> uploadFile(String path) async {
    final file = File(path);
    final bytes = await file.readAsBytes();
    final mediaType = imageMediaTypeForBytes(bytes);
    if (mediaType == null) {
      throw const AttachmentUploadException('UNSUPPORTED_IMAGE');
    }
    final credential = await credentials.read();
    if (credential == null) {
      throw const AttachmentUploadException('UNPAIRED');
    }
    final response = await transport.post(
      Uri.parse('${credential.baseUrl}/v1/attachments'),
      {
        'authorization':
            'Bearer ${credential.deviceId}.${credential.deviceToken}',
        'content-type': 'application/json',
      },
      jsonEncode({'mediaType': mediaType, 'dataBase64': base64Encode(bytes)}),
    );
    if (response.statusCode != 201) {
      throw AttachmentUploadException(
        response.statusCode == 401 ? 'UNAUTHENTICATED' : 'UPLOAD_FAILED',
      );
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map<String, Object?>) {
      throw const AttachmentUploadException('UPLOAD_FAILED');
    }
    final attachmentId = decoded['attachmentId'];
    final returnedType = decoded['mediaType'];
    final size = decoded['size'];
    if (attachmentId is! String ||
        returnedType is! String ||
        size is! int) {
      throw const AttachmentUploadException('UPLOAD_FAILED');
    }
    return UploadedAttachment(
      attachmentId: attachmentId,
      mediaType: returnedType,
      size: size,
    );
  }
}