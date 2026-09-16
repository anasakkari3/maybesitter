// iOS simulator harness (#404): expo-image-manipulator 57.0.18's own iOS decode → fix-orientation →
// resize → jpegData path, with the two transformers copied verbatim from
// node_modules/expo-image-manipulator/ios/Transformers, run over one file without the RN bridge.
//
// Produced `ios-uikit-encoder-from-heic.jpg` from `imageio-gps.heic` on the iOS 26.5 simulator:
//   swiftc -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -target arm64-apple-ios17.0-simulator \
//     manipulatorHarness.swift -o harness
//   xcrun simctl spawn booted "$PWD/harness" "$PWD/imageio-gps.heic" "$PWD/out.jpg" 2048 0.8
// Arguments: <input> <output.jpg> <long edge px> <JPEG quality>.
import UIKit
struct ImageNotFoundException: Error {}
struct ImageColorSpaceNotFoundException: Error {}
struct ImageContextLostException: Error {}
struct ImageDrawingFailedException: Error {}
protocol ImageTransformer { func transform(image: UIImage) async throws -> UIImage }
struct ResizeOptions { var width: Double?; var height: Double? }
internal struct ImageFixOrientationTransformer: ImageTransformer {
  func transform(image: UIImage) async throws -> UIImage {
    guard let cgImage = image.cgImage else {
      throw ImageNotFoundException()
    }
    guard var colorSpace = cgImage.colorSpace else {
      // That should never happen as `colorSpace` is empty only when the image is a mask.
      throw ImageColorSpaceNotFoundException()
    }
    if !colorSpace.supportsOutput {
      colorSpace = CGColorSpaceCreateDeviceRGB()
    }

    var transform = CGAffineTransform.identity

    switch image.imageOrientation {
    case .down, .downMirrored:
      transform = transform.translatedBy(x: image.size.width, y: image.size.height)
      transform = transform.rotated(by: Double.pi)
    case .left, .leftMirrored:
      transform = transform.translatedBy(x: image.size.width, y: 0)
      transform = transform.rotated(by: Double.pi / 2)
    case .right, .rightMirrored:
      transform = transform.translatedBy(x: 0, y: image.size.height)
      transform = transform.rotated(by: -Double.pi / 2)
    default:
      break
    }

    switch image.imageOrientation {
    case .upMirrored, .downMirrored:
      transform = transform.translatedBy(x: image.size.width, y: 0)
      transform = transform.scaledBy(x: -1, y: 1)
    case .leftMirrored, .rightMirrored:
      transform = transform.translatedBy(x: image.size.height, y: 0)
      transform = transform.scaledBy(x: -1, y: 1)
    default:
      break
    }

    let context = CGContext(
      data: nil,
      width: Int(image.size.width),
      height: Int(image.size.height),
      bitsPerComponent: cgImage.bitsPerComponent,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )

    guard let context = context else {
      throw ImageContextLostException()
    }

    context.concatenate(transform)

    switch image.imageOrientation {
    case .left, .leftMirrored, .right, .rightMirrored:
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: image.size.height, height: image.size.width))
    default:
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height))
    }

    guard let newCGImage = context.makeImage() else {
      throw ImageDrawingFailedException()
    }
    return UIImage(cgImage: newCGImage)
  }
}
internal struct ImageResizeTransformer: ImageTransformer {
  let options: ResizeOptions

  func transform(image: UIImage) async -> UIImage {
    let imageWidth = image.size.width
    let imageHeight = image.size.height
    let imageRatio = imageWidth / imageHeight

    var targetSize = CGSize.zero

    if let width = options.width {
      targetSize.width = width
      targetSize.height = width / imageRatio
    }
    if let height = options.height {
      targetSize.height = height
      targetSize.width = targetSize.width == 0 ? imageRatio * targetSize.height : targetSize.width
    }

    let format = UIGraphicsImageRendererFormat()
    format.opaque = false
    format.scale = 1

    let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: targetSize))
    }
  }
}

let args = CommandLine.arguments
let input = args[1], output = args[2], longEdge = Double(args[3])!, quality = Double(args[4])!
let sem = DispatchSemaphore(value: 0)
Task {
  do {
    // ImageManipulatorUtils.swift loadImage(): local file → Data → UIImage(data:)
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: input)), let loaded = UIImage(data: data) else {
      print("DECODE_FAILED"); exit(3)
    }
    print("loaded size=\(loaded.size) orientation=\(loaded.imageOrientation.rawValue)")
    var image = try await ImageFixOrientationTransformer().transform(image: loaded)
    let w = Double(image.cgImage!.width), h = Double(image.cgImage!.height)
    print("oriented px=\(Int(w))x\(Int(h))")
    if max(w, h) > longEdge {
      let scale = longEdge / max(w, h)
      image = await ImageResizeTransformer(options: ResizeOptions(width: (w * scale).rounded(), height: (h * scale).rounded())).transform(image: image)
    }
    // ImageManipulatorUtils.swift imageData(): .jpeg → image.jpegData(compressionQuality:)
    let jpeg = image.jpegData(compressionQuality: quality)!
    try jpeg.write(to: URL(fileURLWithPath: output))
    print("encoded px=\(image.cgImage!.width)x\(image.cgImage!.height) bytes=\(jpeg.count)")
  } catch { print("ERROR \(error)"); exit(4) }
  sem.signal()
}
sem.wait()
